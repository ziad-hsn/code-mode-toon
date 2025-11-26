import type { WorkflowDefinition } from '../src/workflow-types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * WORKFLOW: research
 * 
 * Comprehensive multi-source research aggregator that orchestrates
 * parallel data fetching from Context7, Wikipedia, and Perplexity.
 * Features parallel execution, retry logic, rate limiting, synthesis,
 * and graceful degradation across MCP servers.
 * 
 * @example
 * execute_workflow({ 
 *   name: 'research', 
 *   params: { 
 *     goal: 'Analyze xsync vs sync.Map performance',
 *     libraryIDs: ['puzpuzpuz/xsync'],
 *     queries: ['xsync vs sync.Map benchmarks']
 *   } 
 * })
 */

// ============================================
// TYPES
// ============================================

interface ResearchResult {
    source: 'context7' | 'wikipedia' | 'perplexity' | 'brave-search';
    identifier: string;
    data: unknown;
    error: null;
    durationMs: number;
}

interface ResearchError {
    source: 'context7' | 'wikipedia' | 'perplexity' | 'brave-search';
    identifier: string;
    data: null;
    error: string;
    durationMs: number;
}

type ResearchItem = ResearchResult | ResearchError;

interface SynthesisResult {
    keyThemes: string[];
    contradictions: string[];
    confidenceAssessment: string;
    recommendations: string[];
    rawResponse?: string;
}

interface ResearchStats {
    total: number;
    successful: number;
    failed: number;
    totalDurationMs: number;
    bySource: Record<string, { success: number; failed: number }>;
}

interface ResearchOutput {
    success: boolean;
    goal: string;
    timestamp: string;
    synthesis?: SynthesisResult | string;
    concatenated?: string;
    results: ResearchItem[];
    stats: ResearchStats;
    errors?: string[];
    outputFile?: string;
}

// ============================================
// HELPERS
// ============================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Retry with exponential backoff and jitter
 */
async function retry<T>(
    fn: () => Promise<T>,
    label: string,
    options: {
        maxRetries?: number;
        baseDelay?: number;
        maxDelay?: number;
        onRetry?: (attempt: number, error: Error) => void;
    } = {}
): Promise<T> {
    const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, onRetry } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err as Error;
            if (attempt < maxRetries - 1) {
                // Exponential backoff with jitter
                const delay = Math.min(
                    baseDelay * Math.pow(2, attempt) + Math.random() * 500,
                    maxDelay
                );
                onRetry?.(attempt + 1, lastError);
                await sleep(delay);
            }
        }
    }
    throw lastError;
}

/**
 * Wrap operation with error capture and timing - never throws
 */
async function safeExecute<T>(
    fn: () => Promise<T>,
    source: ResearchItem['source'],
    identifier: string
): Promise<ResearchResult | ResearchError> {
    const start = Date.now();
    try {
        const data = await fn();
        return {
            source,
            identifier,
            data,
            error: null,
            durationMs: Date.now() - start
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            source,
            identifier,
            data: null,
            error: message,
            durationMs: Date.now() - start
        };
    }
}

/**
 * Process items in batches with rate limiting
 */
async function processBatches<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    options: { batchSize?: number; delayMs?: number } = {}
): Promise<R[]> {
    const { batchSize = 5, delayMs = 500 } = options;
    const results: R[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);

        // Rate limit between batches
        if (i + batchSize < items.length) {
            await sleep(delayMs);
        }
    }

    return results;
}

/**
 * Check if file path is writable
 */
async function validateOutputPath(filePath: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const dir = path.dirname(filePath);
        await fs.access(dir, fs.constants.W_OK);
        return { valid: true };
    } catch {
        try {
            // Try to create directory
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            return { valid: true };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { valid: false, error: `Cannot write to ${filePath}: ${message}` };
        }
    }
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

/**
 * Safely stringify data for concatenation
 */
function safeStringify(data: unknown, maxLength = 10000): string {
    try {
        const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return truncate(str, maxLength);
    } catch {
        return '[Unable to stringify data]';
    }
}

/**
 * Build synthesis prompt from results
 */
function buildSynthesisPrompt(goal: string, results: ResearchResult[]): string {
    const findings = results.map((r, i) => {
        const dataStr = safeStringify(r.data, 2000);
        return `[${i + 1}. ${r.source.toUpperCase()}: ${r.identifier}]\n${dataStr}`;
    }).join('\n\n---\n\n');

    return `You are a research analyst synthesizing findings for this goal:
"${goal}"

## Research Findings

${findings}

## Your Task

Analyze these findings and provide a structured synthesis:

1. **Key Themes** (3-5 bullet points): Main ideas that appear across sources
2. **Contradictions**: Any conflicting information between sources
3. **Confidence Assessment**: How reliable are these findings? What's missing?
4. **Recommendations** (3-5 bullet points): Actionable next steps or areas needing more research

Be concise and focus on insights relevant to the stated goal.`;
}

/**
 * Format results as concatenated text
 */
function formatConcatenated(results: ResearchResult[]): string {
    return results.map(r => {
        const separator = '='.repeat(80);
        const dataStr = safeStringify(r.data, 15000);
        return `
${separator}
SOURCE: ${r.source.toUpperCase()}
IDENTIFIER: ${r.identifier}
FETCHED IN: ${r.durationMs}ms
${separator}

${dataStr}
`;
    }).join('\n');
}

/**
 * Calculate stats from results
 */
function calculateStats(results: ResearchItem[], totalDurationMs: number): ResearchStats {
    const bySource: Record<string, { success: number; failed: number }> = {};

    for (const r of results) {
        if (!bySource[r.source]) {
            bySource[r.source] = { success: 0, failed: 0 };
        }
        if (r.error) {
            bySource[r.source].failed++;
        } else {
            bySource[r.source].success++;
        }
    }

    return {
        total: results.length,
        successful: results.filter(r => !r.error).length,
        failed: results.filter(r => r.error).length,
        totalDurationMs,
        bySource
    };
}

// ============================================
// WORKFLOW DEFINITION
// ============================================

export const workflow: WorkflowDefinition = {
    name: 'research',

    description: `Multi-source research aggregator with parallel execution and synthesis |
USAGE: Orchestrates data fetching from Context7 (library docs), Wikipedia (concepts),
and Perplexity (web Q&A). Supports parallel execution, retry logic, rate limiting,
optional LLM synthesis, and file output.
EXAMPLE: "Research xsync library performance vs sync.Map with benchmarks and theory"
PARAMETERS:
- goal: Primary research objective (required)
- libraryIDs: Context7 library IDs for docs ["puzpuzpuz/xsync"] (optional)
- queries: Perplexity questions ["xsync benchmarks?"] (optional)
- wikipediaTopics: Wikipedia articles ["Lock-free data structures"] (optional)
- synthesize: LLM synthesis of findings (optional, default: false)
- outputFile: Path to save TOON-compressed results (optional)
- batchSize: Max parallel requests per source (optional, default: 5)
REQUIRES: At least one of: context7, wikipedia, perplexity (optional: brave-search as fallback)
NOTES: Gracefully degrades if MCPs unavailable. Large outputs auto-TOON-encode.`,

    parameters: {
        goal: {
            type: 'string',
            description: 'Primary research objective - be specific about what you want to learn',
            required: true
        },
        libraryIDs: {
            type: 'array',
            description: 'Context7 library IDs for documentation (e.g., ["uber-go/zap", "puzpuzpuz/xsync"])',
            required: false
        },
        queries: {
            type: 'array',
            description: 'Questions for Perplexity web search (e.g., ["xsync vs sync.Map benchmarks"])',
            required: false
        },
        wikipediaTopics: {
            type: 'array',
            description: 'Wikipedia article titles (e.g., ["Lock-free data structures", "Little\'s law"])',
            required: false
        },
        synthesize: {
            type: 'boolean',
            description: 'Use LLM to synthesize findings into structured summary',
            required: false,
            default: false
        },
        outputFile: {
            type: 'string',
            description: 'Path to save TOON-compressed research results',
            required: false
        },
        batchSize: {
            type: 'number',
            description: 'Max parallel requests per source (rate limiting)',
            required: false,
            default: 5
        }
    },

    async execute(params, context) {
        const {
            goal,
            libraryIDs = [],
            queries = [],
            wikipediaTopics = [],
            synthesize = false,
            outputFile,
            batchSize = 5
        } = params;

        const startTime = Date.now();
        const allResults: ResearchItem[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];

        // ========================================
        // STEP 1: Progress logging setup
        // ========================================
        const hasLibraries = libraryIDs.length > 0;
        const hasWikipedia = wikipediaTopics.length > 0;
        const hasQueries = queries.length > 0;

        // Calculate total steps dynamically
        let totalSteps = 2; // Plan + Final
        if (hasLibraries) totalSteps++;
        if (hasWikipedia) totalSteps++;
        if (hasQueries) totalSteps++;
        if (synthesize) totalSteps++;
        if (outputFile) totalSteps++;

        let currentStep = 1;

        const logProgress = async (message: string) => {
            console.error(`[research] [${currentStep}/${totalSteps}] ${message}`);
            if (context.servers['sequential-thinking']) {
                try {
                    await context.servers['sequential-thinking'].sequentialthinking({
                        thought: message,
                        thoughtNumber: currentStep,
                        totalThoughts: totalSteps,
                        nextThoughtNeeded: currentStep < totalSteps
                    });
                } catch {
                    // Silent fail for logging
                }
            }
            currentStep++;
        };

        // ========================================
        // STEP 2: Research plan
        // ========================================
        const planSummary = [
            `Goal: "${truncate(goal, 100)}"`,
            hasLibraries ? `Libraries: ${libraryIDs.length}` : null,
            hasWikipedia ? `Wikipedia: ${wikipediaTopics.length}` : null,
            hasQueries ? `Queries: ${queries.length}` : null,
            `Synthesis: ${synthesize ? 'yes' : 'no'}`,
            outputFile ? `Output: ${path.basename(outputFile)}` : null
        ].filter(Boolean).join(' | ');

        await logProgress(`Research plan: ${planSummary}`);

        // Check MCP availability
        const availableMCPs: string[] = [];
        if (context.servers['context7']) availableMCPs.push('context7');
        if (context.servers['wikipedia']) availableMCPs.push('wikipedia');
        if (context.servers['perplexity']) availableMCPs.push('perplexity');
        if (context.servers['brave-search']) availableMCPs.push('brave-search');

        if (availableMCPs.length === 0) {
            return {
                success: false,
                goal,
                timestamp: new Date().toISOString(),
                results: [],
                stats: calculateStats([], Date.now() - startTime),
                errors: ['No research MCPs available. Need at least one of: context7, wikipedia, perplexity']
            };
        }

        console.error(`[research] Available MCPs: ${availableMCPs.join(', ')}`);

        // ========================================
        // STEP 3: Fetch Context7 library docs
        // ========================================
        if (hasLibraries) {
            if (context.servers['context7']) {
                await logProgress(`Fetching ${libraryIDs.length} libraries from Context7...`);

                const libResults = await processBatches(
                    libraryIDs,
                    (libraryID: string) => safeExecute(
                        () => retry(
                            () => context.servers['context7']['get-library-docs']({
                                context7CompatibleLibraryID: libraryID
                            }),
                            `context7:${libraryID}`
                        ),
                        'context7',
                        libraryID
                    ),
                    { batchSize, delayMs: 300 }
                );

                allResults.push(...libResults);
                const success = libResults.filter(r => !r.error).length;
                console.error(`[research] Context7: ${success}/${libraryIDs.length} successful`);
            } else {
                warnings.push('context7 MCP not available - skipping library docs');
                console.error(`[research] Warning: context7 not available`);
            }
        }

        // ========================================
        // STEP 4: Fetch Wikipedia articles
        // ========================================
        if (hasWikipedia) {
            if (context.servers['wikipedia']) {
                await logProgress(`Fetching ${wikipediaTopics.length} Wikipedia articles...`);

                const wikiResults = await processBatches(
                    wikipediaTopics,
                    (topic: string) => safeExecute(
                        () => retry(
                            () => context.servers['wikipedia'].readArticle({ title: topic }),
                            `wikipedia:${topic}`
                        ),
                        'wikipedia',
                        topic
                    ),
                    { batchSize, delayMs: 200 }
                );

                allResults.push(...wikiResults);
                const success = wikiResults.filter(r => !r.error).length;
                console.error(`[research] Wikipedia: ${success}/${wikipediaTopics.length} successful`);
            } else {
                warnings.push('wikipedia MCP not available - skipping articles');
                console.error(`[research] Warning: wikipedia not available`);
            }
        }

        // ========================================
        // STEP 5: Execute Perplexity queries
        // ========================================
        if (hasQueries) {
            // Prefer perplexity, fallback to brave-search
            const searchServer = context.servers['perplexity'] || context.servers['brave-search'];
            const searchSource: 'perplexity' | 'brave-search' = context.servers['perplexity']
                ? 'perplexity'
                : 'brave-search';

            if (searchServer) {
                await logProgress(`Executing ${queries.length} queries via ${searchSource}...`);

                const queryResults = await processBatches(
                    queries,
                    (query: string) => safeExecute(
                        () => retry(
                            async () => {
                                if (searchSource === 'perplexity') {
                                    return context.servers['perplexity'].perplexity_ask({
                                        messages: [{ role: 'user', content: query }]
                                    });
                                } else {
                                    return context.servers['brave-search'].search({ query });
                                }
                            },
                            `${searchSource}:${query}`
                        ),
                        searchSource,
                        query
                    ),
                    { batchSize: Math.min(batchSize, 3), delayMs: 1000 } // More conservative for search APIs
                );

                allResults.push(...queryResults);
                const success = queryResults.filter(r => !r.error).length;
                console.error(`[research] ${searchSource}: ${success}/${queries.length} successful`);

                if (searchSource === 'brave-search') {
                    warnings.push('Using brave-search fallback (perplexity recommended for better results)');
                }
            } else {
                warnings.push('No search MCP available (perplexity or brave-search) - skipping queries');
                console.error(`[research] Warning: no search MCP available`);
            }
        }

        // ========================================
        // STEP 6: Synthesis or concatenation
        // ========================================
        const successfulResults = allResults.filter((r): r is ResearchResult => !r.error);
        const failedResults = allResults.filter(r => r.error);

        let synthesis: string | SynthesisResult | undefined;
        let concatenated: string | undefined;

        if (successfulResults.length === 0) {
            errors.push('No successful results to synthesize');
        } else if (synthesize) {
            if (context.servers['perplexity']) {
                await logProgress(`Synthesizing ${successfulResults.length} results...`);

                try {
                    const prompt = buildSynthesisPrompt(goal, successfulResults);
                    const response = await retry(
                        () => context.servers['perplexity'].perplexity_ask({
                            messages: [{ role: 'user', content: prompt }]
                        }),
                        'synthesis'
                    );

                    synthesis = typeof response === 'string' ? response : {
                        keyThemes: [],
                        contradictions: [],
                        confidenceAssessment: 'See raw response',
                        recommendations: [],
                        rawResponse: safeStringify(response, 5000)
                    };

                    console.error(`[research] Synthesis complete`);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push(`Synthesis failed: ${message}`);
                    // Fallback to concatenation
                    concatenated = formatConcatenated(successfulResults);
                }
            } else {
                warnings.push('perplexity not available for synthesis - using concatenation');
                concatenated = formatConcatenated(successfulResults);
            }
        } else {
            // Just concatenate
            concatenated = formatConcatenated(successfulResults);
        }

        // ========================================
        // STEP 7: Save output file
        // ========================================
        if (outputFile) {
            await logProgress(`Saving results to ${path.basename(outputFile)}...`);

            const pathCheck = await validateOutputPath(outputFile);
            if (!pathCheck.valid) {
                errors.push(pathCheck.error!);
            } else {
                const outputData = {
                    goal,
                    timestamp: new Date().toISOString(),
                    synthesis: synthesis || undefined,
                    results: allResults,
                    stats: calculateStats(allResults, Date.now() - startTime),
                    warnings: warnings.length > 0 ? warnings : undefined
                };

                try {
                    const toonData = context.encode(outputData);
                    const absolutePath = path.resolve(process.cwd(), outputFile);
                    await fs.writeFile(absolutePath, toonData, 'utf-8');
                    console.error(`[research] ✓ Saved to ${absolutePath}`);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to write file: ${message}`);
                }
            }
        }

        // ========================================
        // FINAL: Build response
        // ========================================
        const totalDuration = Date.now() - startTime;
        const stats = calculateStats(allResults, totalDuration);

        const summary = [
            `Research complete in ${(totalDuration / 1000).toFixed(1)}s`,
            `${stats.successful}/${stats.total} successful`,
            failedResults.length > 0 ? `${failedResults.length} failed` : null
        ].filter(Boolean).join(' | ');

        await logProgress(summary);

        // Build final output
        const output: ResearchOutput = {
            success: errors.length === 0 && stats.successful > 0,
            goal,
            timestamp: new Date().toISOString(),
            synthesis: synthesis || undefined,
            concatenated: !synthesis ? concatenated : undefined,
            results: allResults,
            stats,
            errors: errors.length > 0 ? errors : undefined,
            outputFile: outputFile || undefined
        };

        // TOON-encode if large
        if (JSON.stringify(output).length > 10000) {
            return context.encode(output);
        }

        return output;
    }
};