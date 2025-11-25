import type { WorkflowDefinition } from '../src/workflow-types.js';
import { z } from 'zod';

// Helper: Retry with exponential backoff
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

export const workflow: WorkflowDefinition = {
    name: 'research',
    description: 'A comprehensive, multi-source research workflow designed for complex technical inquiries. It orchestrates parallel data fetching from Context7 (library documentation), Wikipedia (general knowledge), and Perplexity (web search & Q&A). Features include: 1) Parallel execution for speed, 2) Robust retry logic with exponential backoff, 3) Optional LLM-based synthesis of findings, and 4) File output capabilities. Use this workflow when you need to deeply understand a topic, library, or problem by gathering information from multiple authoritative sources simultaneously.',

    parameters: {
        goal: {
            type: 'string',
            description: 'The primary objective of the research. Be specific about what you want to achieve (e.g., "Analyze the thread-safety of the xsync library and compare it to standard Go sync maps").',
            required: true
        },
        libraryIDs: {
            type: 'array',
            description: 'List of Context7-compatible library IDs to fetch full documentation for. Use this for deep technical dives into specific libraries (e.g., ["nodejs/node", "expressjs/express", "uber-go/zap"]).',
            required: false
        },
        queries: {
            type: 'array',
            description: 'List of specific questions to ask Perplexity. Use this for finding best practices, comparisons, troubleshooting, or information not found in standard docs (e.g., ["What are the performance trade-offs of xsync vs sync.Map?", "Common pitfalls when using zap logger"]).',
            required: false
        },
        wikipediaTopics: {
            type: 'array',
            description: 'List of Wikipedia article titles to fetch. Use this for foundational concepts, algorithms, or theoretical background (e.g., ["Queueing theory", "Little\'s law", "Distributed hash table"]).',
            required: false
        },
        synthesize: {
            type: 'boolean',
            description: 'If true, performs an additional step using Perplexity to analyze all gathered data and generate a structured summary (Key Themes, Contradictions, Recommendations). If false, returns raw concatenated data. Default: false.',
            required: false
        },
        outputFile: {
            type: 'string',
            description: 'Absolute path to save the complete research result as a JSON file. Useful for persisting large research sessions for later analysis. (e.g., "/home/user/research/auth_study.json")',
            required: false
        }
    },

    async execute(params, context) {
        const { goal, libraryIDs = [], queries = [], wikipediaTopics = [], synthesize = false, outputFile } = params;
        const results: any[] = [];

        // Helper to log structured thoughts
        const think = async (thought: string, step: number, total: number) => {
            if (context.servers['sequential-thinking']) {
                try {
                    await context.servers['sequential-thinking'].sequentialthinking({
                        thought,
                        thoughtNumber: step,
                        totalThoughts: total,
                        nextThoughtNeeded: step < total
                    });
                } catch (err) {
                    // Silent fail for logging
                }
            }
        };

        const totalSteps = 6;
        let currentStep = 1;

        // Step 1: Plan
        await think(
            `Research Plan for: "${goal}"\n` +
            `- Libraries to fetch: ${libraryIDs.length > 0 ? libraryIDs.join(', ') : 'none'}\n` +
            `- Wikipedia topics: ${wikipediaTopics.length > 0 ? wikipediaTopics.join(', ') : 'none'}\n` +
            `- Perplexity queries: ${queries.length > 0 ? queries.length : 'none'}\n` +
            `Strategy: Parallel execution with retry logic + synthesis`,
            currentStep++,
            totalSteps
        );

        // Step 2: Fetch ALL documentation in parallel (Context7)
        if (libraryIDs.length > 0 && context.servers['context7']) {
            await think(`Fetching ${libraryIDs.length} libraries in parallel...`, currentStep++, totalSteps);

            const docPromises = libraryIDs.map((libraryID: string) =>
                retryWithBackoff(async () => {
                    const docs = await context.servers['context7']['get-library-docs']({
                        context7CompatibleLibraryID: libraryID
                    });
                    return { source: 'context7', libraryID, data: docs };
                }).catch(err => ({
                    source: 'context7',
                    libraryID,
                    error: err.message
                }))
            );

            const docResults = await Promise.all(docPromises);
            results.push(...docResults);

            const successCount = docResults.filter(r => !r.error).length;
            await think(`✓ Fetched ${successCount}/${libraryIDs.length} libraries`, currentStep++, totalSteps);
        } else {
            currentStep++; // Skip doc step
        }

        // Step 3: Fetch Wikipedia articles in parallel
        if (wikipediaTopics.length > 0 && context.servers['wikipedia']) {
            await think(`Fetching ${wikipediaTopics.length} Wikipedia articles in parallel...`, currentStep++, totalSteps);

            const wikiPromises = wikipediaTopics.map((topic: string) =>
                retryWithBackoff(async () => {
                    // Use readArticle method (not summary)
                    const article = await context.servers['wikipedia'].readArticle({
                        title: topic
                    });
                    return { source: 'wikipedia', topic, data: article };
                }).catch(err => ({
                    source: 'wikipedia',
                    topic,
                    error: err.message
                }))
            );

            const wikiResults = await Promise.all(wikiPromises);
            results.push(...wikiResults);

            const successCount = wikiResults.filter(r => !r.error).length;
            await think(`✓ Fetched ${successCount}/${wikipediaTopics.length} Wikipedia articles`, currentStep++, totalSteps);
        } else {
            currentStep++; // Skip Wikipedia step
        }

        // Step 4: Ask ALL queries in parallel (Perplexity)
        if (queries.length > 0 && context.servers['perplexity']) {
            await think(`Executing ${queries.length} queries in parallel...`, currentStep++, totalSteps);

            const queryPromises = queries.map((query: string) =>
                retryWithBackoff(async () => {
                    const response = await context.servers['perplexity'].perplexity_ask({
                        messages: [{ role: 'user', content: query }]
                    });
                    return { source: 'perplexity', query, data: response };
                }).catch(err => ({
                    source: 'perplexity',
                    query,
                    error: err.message
                }))
            );

            const queryResults = await Promise.all(queryPromises);
            results.push(...queryResults);

            const successCount = queryResults.filter(r => !r.error).length;
            await think(`✓ Answered ${successCount}/${queries.length} queries`, currentStep++, totalSteps);
        } else {
            currentStep++; // Skip query step
        }

        // Step 5: Synthesize or concatenate findings
        let synthesis = null;
        let concatenated = null;
        const successfulResults = results.filter(r => !r.error);
        const failedResults = results.filter(r => r.error);

        if (successfulResults.length > 0) {
            if (synthesize && context.servers['perplexity']) {
                // LLM-based synthesis
                await think(`Synthesizing ${successfulResults.length} results...`, currentStep++, totalSteps);

                try {
                    const findingsText = successfulResults.map(r => {
                        const source = r.source || 'unknown';
                        const identifier = r.libraryID || r.topic || r.query || 'unknown';
                        const dataStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
                        // Safely limit length and escape
                        return `[${source.toUpperCase()}: ${identifier}]\n${dataStr.substring(0, 1000)}...`;
                    }).join('\n\n');

                    const synthesisPrompt = `Based on the following research findings for goal: "${goal}"

${findingsText}

Please synthesize these findings into:
1. **Key Themes**: Main ideas across all sources
2. **Contradictions**: Any conflicting information
3. **Confidence Assessment**: How reliable are these findings
4. **Recommendations**: Next steps or areas needing more research

Provide a concise, structured summary.`;

                    const synthesisResponse = await retryWithBackoff(async () => {
                        return await context.servers['perplexity'].perplexity_ask({
                            messages: [{ role: 'user', content: synthesisPrompt }]
                        });
                    });

                    synthesis = synthesisResponse;
                    await think(`✓ Synthesis complete`, currentStep++, totalSteps);
                } catch (err: any) {
                    await think(`✗ Synthesis failed: ${err.message}`, currentStep++, totalSteps);
                }
            } else {
                // Simple concatenation
                await think(`Concatenating ${successfulResults.length} results...`, currentStep++, totalSteps);

                concatenated = successfulResults.map(r => {
                    const source = r.source || 'unknown';
                    const identifier = r.libraryID || r.topic || r.query || 'unknown';
                    // Safe stringification
                    let dataStr: string;
                    try {
                        dataStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
                    } catch (e) {
                        dataStr = '[Unable to stringify data]';
                    }

                    return `\n${'='.repeat(80)}\nSOURCE: ${source.toUpperCase()}\nIDENTIFIER: ${identifier}\n${'='.repeat(80)}\n${dataStr}\n`;
                }).join('\n');

                await think(`✓ Concatenation complete`, currentStep++, totalSteps);
            }
        } else {
            currentStep++; // Skip synthesis/concatenation
        }

        // Step 6: Optional file output
        if (outputFile && (synthesis || concatenated)) {
            try {
                const fs = await import('fs/promises');
                const path = await import('path');

                const outputData = {
                    goal,
                    timestamp: new Date().toISOString(),
                    summary: `Research complete: ${successfulResults.length} successful, ${failedResults.length} failed.\nTotal sources: ${libraryIDs.length} libraries, ${wikipediaTopics.length} Wikipedia articles, ${queries.length} queries.`,
                    synthesis: synthesize ? synthesis : null,
                    concatenated: synthesize ? null : concatenated,
                    results,
                    stats: {
                        total: results.length,
                        successful: successfulResults.length,
                        failed: failedResults.length
                    }
                };

                // Use TOON encoding for file output
                // We need to dynamically import TOON since this is a standalone workflow file
                // In a real scenario, this would be available via context or global
                // For now, we'll use a simple JSON fallback if TOON isn't globally available, 
                // but we assume the environment provides it or we import it.

                // Since we can't easily import from src in a compiled workflow without relative paths hell,
                // and we want this to be portable, let's check if TOON is available in global scope (it might be injected)
                // or just use a simplified TOON-like structure if not.

                // Ideally, the context object should provide a helper for this.
                // Let's assume for now we use JSON but with a .toon extension recommendation
                // Wait, the user explicitly asked for TOON. 
                // We should probably inject TOONEncoder into the context or import it.

                // Use TOON encoding via context helper
                // Exclude 'concatenated' from file output to avoid duplication with 'results'
                const { concatenated: _ignore, ...fileOutputData } = outputData;
                const toonData = context.encode(fileOutputData);

                await fs.writeFile(outputFile, toonData, 'utf-8');
                await think(`✓ Results written to ${outputFile}`, currentStep++, totalSteps);
            } catch (err: any) {
                await think(`✗ Failed to write file: ${err.message}`, currentStep++, totalSteps);
            }
        }

        // Final summary
        const summary =
            `Research complete: ${successfulResults.length} successful, ${failedResults.length} failed.\n` +
            `Total sources: ${libraryIDs.length} libraries, ${wikipediaTopics.length} Wikipedia articles, ${queries.length} queries.`;

        await think(summary, totalSteps, totalSteps);

        return {
            goal,
            summary,
            synthesis: synthesize ? synthesis : undefined,
            concatenated: synthesize ? undefined : concatenated,
            outputFile: outputFile || undefined,
            results,
            stats: {
                total: results.length,
                successful: successfulResults.length,
                failed: failedResults.length
            }
        };
    }
}