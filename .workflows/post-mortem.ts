import type { WorkflowDefinition } from '../src/workflow-types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';

/**
 * WORKFLOW: post-mortem
 * 
 * Intelligent log analysis that clusters patterns, identifies anomalies,
 * and preserves rich data for LLM-assisted root cause analysis.
 * 
 * @example
 * execute_workflow({ name: 'post-mortem', params: { logFile: './app.log', outputFile: './analysis.toon' } })
 */

// ============================================
// TYPES
// ============================================

interface DynamicData {
    timestamps: string[];
    uuids: string[];
    ips: string[];
    requestIds: string[];
    userIds: string[];
    paths: string[];
    statusCodes: string[];
    latencies: string[];
}

interface LogCluster {
    signature: string;
    count: number;
    severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';
    category: 'error' | 'security' | 'performance' | 'normal';
    examples: string[];
    dynamicData: Partial<DynamicData>;
    firstSeen: string | null;
    lastSeen: string | null;
    lineNumbers: number[];
}

interface TimeSeriesBucket {
    timestamp: string;
    total: number;
    errors: number;
    warnings: number;
}

interface AnalysisStats {
    totalLines: number;
    emptyLines: number;
    clusterCount: number;
    anomalyCount: number;
    errorCount: number;
    warningCount: number;
    timeSpanMinutes: number;
    peakMinute: string | null;
    peakCount: number;
}

interface SignatureResult {
    signature: string;
    severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';
    category: 'error' | 'security' | 'performance' | 'normal';
    dynamicData: Partial<DynamicData>;
}

// ============================================
// HELPERS
// ============================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Wrap operation with error capture - never throws
 */
async function safeExecute<T>(
    fn: () => Promise<T>,
    label: string
): Promise<{ data: T; error: null } | { data: null; error: string }> {
    try {
        return { data: await fn(), error: null };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { data: null, error: `[${label}] ${message}` };
    }
}

/**
 * Check if file exists and is readable
 */
async function validateFile(filePath: string): Promise<{ valid: boolean; error?: string; size?: number }> {
    try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            return { valid: false, error: `${filePath} is not a file` };
        }
        return { valid: true, size: stats.size };
    } catch {
        return { valid: false, error: `File not found: ${filePath}` };
    }
}

/**
 * Pattern matchers for dynamic data extraction
 */
const PATTERNS = {
    // Timestamps: ISO, common log formats
    timestamp: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/g,

    // UUIDs
    uuid: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,

    // IPv4 addresses
    ip: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,

    // Request IDs (common formats)
    requestId: /(?:req[-_]?id|request[-_]?id|x-request-id|trace[-_]?id)[=:\s]+["']?([a-zA-Z0-9_-]{8,64})["']?/gi,

    // User IDs
    userId: /(?:user[-_]?id|uid|user)[=:\s]+["']?([a-zA-Z0-9_-]{1,64})["']?/gi,

    // URL paths
    path: /(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s?]+)/g,

    // HTTP status codes
    statusCode: /\b[1-5][0-9]{2}\b/g,

    // Latency/duration (ms, s, µs)
    latency: /\b(\d+(?:\.\d+)?)\s*(?:ms|s|µs|microseconds|milliseconds|seconds)\b/gi,

    // Hex values
    hex: /0x[0-9a-fA-F]+/g,

    // Large numbers (likely IDs)
    largeNumber: /\b[1-9]\d{6,}\b/g,
};

/**
 * Severity patterns for log level detection
 */
const SEVERITY_PATTERNS = {
    CRITICAL: /\b(FATAL|CRITICAL|PANIC|EMERGENCY)\b/i,
    ERROR: /\b(ERROR|ERR|FAIL(?:ED|URE)?|Exception|EPIPE|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b/i,
    WARNING: /\b(WARN(?:ING)?|DEPRECATED|RETRY|TIMEOUT)\b/i,
    DEBUG: /\b(DEBUG|TRACE|VERBOSE)\b/i,
};

/**
 * Category patterns for issue classification
 */
const CATEGORY_PATTERNS = {
    security: /\b(auth(?:entication|orization)?|forbidden|unauthorized|403|401|denied|permission|token|jwt|cors|xss|injection|csrf)\b/i,
    performance: /\b(slow|timeout|latency|duration|elapsed|took\s+\d|performance|memory|cpu|oom|heap|gc)\b/i,
    error: /\b(error|exception|fail|crash|panic|fatal|critical)\b/i,
};

/**
 * Extract dynamic data and create signature from log line
 */
function analyzeLogLine(line: string): SignatureResult {
    let signature = line;
    const dynamicData: Partial<DynamicData> = {};

    // Extract and mask timestamps
    const timestamps = line.match(PATTERNS.timestamp) || [];
    if (timestamps.length > 0) {
        dynamicData.timestamps = timestamps;
        signature = signature.replace(PATTERNS.timestamp, '<TIME>');
    }

    // Extract and mask UUIDs
    const uuids = line.match(PATTERNS.uuid) || [];
    if (uuids.length > 0) {
        dynamicData.uuids = uuids;
        signature = signature.replace(PATTERNS.uuid, '<UUID>');
    }

    // Extract and mask IPs
    const ips = line.match(PATTERNS.ip) || [];
    if (ips.length > 0) {
        dynamicData.ips = ips;
        signature = signature.replace(PATTERNS.ip, '<IP>');
    }

    // Extract request IDs
    const reqMatches = [...line.matchAll(PATTERNS.requestId)];
    if (reqMatches.length > 0) {
        dynamicData.requestIds = reqMatches.map(m => m[1]);
        signature = signature.replace(PATTERNS.requestId, '$1=<REQ_ID>');
    }

    // Extract user IDs
    const userMatches = [...line.matchAll(PATTERNS.userId)];
    if (userMatches.length > 0) {
        dynamicData.userIds = userMatches.map(m => m[1]);
        signature = signature.replace(PATTERNS.userId, '$1=<USER_ID>');
    }

    // Extract paths
    const pathMatches = [...line.matchAll(PATTERNS.path)];
    if (pathMatches.length > 0) {
        dynamicData.paths = pathMatches.map(m => m[1]);
    }

    // Extract status codes
    const statusCodes = line.match(PATTERNS.statusCode) || [];
    if (statusCodes.length > 0) {
        dynamicData.statusCodes = statusCodes;
    }

    // Extract latencies
    const latencyMatches = [...line.matchAll(PATTERNS.latency)];
    if (latencyMatches.length > 0) {
        dynamicData.latencies = latencyMatches.map(m => m[0]);
        signature = signature.replace(PATTERNS.latency, '<LATENCY>');
    }

    // Mask hex and large numbers
    signature = signature.replace(PATTERNS.hex, '<HEX>');
    signature = signature.replace(PATTERNS.largeNumber, '<ID>');

    // Determine severity
    let severity: SignatureResult['severity'] = 'INFO';
    if (SEVERITY_PATTERNS.CRITICAL.test(line)) severity = 'CRITICAL';
    else if (SEVERITY_PATTERNS.ERROR.test(line)) severity = 'ERROR';
    else if (SEVERITY_PATTERNS.WARNING.test(line)) severity = 'WARNING';
    else if (SEVERITY_PATTERNS.DEBUG.test(line)) severity = 'DEBUG';

    // Determine category
    let category: SignatureResult['category'] = 'normal';
    if (CATEGORY_PATTERNS.security.test(line)) category = 'security';
    else if (CATEGORY_PATTERNS.error.test(line)) category = 'error';
    else if (CATEGORY_PATTERNS.performance.test(line)) category = 'performance';

    return { signature: signature.trim(), severity, category, dynamicData };
}

/**
 * Merge dynamic data arrays (with limit)
 */
function mergeDynamicData(
    existing: Partial<DynamicData>,
    incoming: Partial<DynamicData>,
    limit = 50
): Partial<DynamicData> {
    const result: Partial<DynamicData> = { ...existing };

    for (const key of Object.keys(incoming) as (keyof DynamicData)[]) {
        const existingArr = result[key] || [];
        const incomingArr = incoming[key] || [];
        const combined = [...existingArr, ...incomingArr];
        result[key] = combined.slice(0, limit);
    }

    return result;
}

/**
 * Calculate time span in minutes between two ISO timestamps
 */
function getTimeSpanMinutes(first: string | null, last: string | null): number {
    if (!first || !last) return 0;
    try {
        const firstDate = new Date(first);
        const lastDate = new Date(last);
        return Math.round((lastDate.getTime() - firstDate.getTime()) / 60000);
    } catch {
        return 0;
    }
}

/**
 * Generate markdown report from analysis
 */
function generateReport(
    logFile: string,
    stats: AnalysisStats,
    anomalies: LogCluster[],
    patterns: LogCluster[],
    timeSeries: Map<string, TimeSeriesBucket>
): string {
    const formatCluster = (c: LogCluster, includeExample = true) => {
        const sig = c.signature.length > 120 ? c.signature.substring(0, 117) + '...' : c.signature;
        let result = `- **[${c.count}x] [${c.severity}]** \`${sig}\``;
        if (includeExample && c.examples[0]) {
            const ex = c.examples[0].length > 100 ? c.examples[0].substring(0, 97) + '...' : c.examples[0];
            result += `\n  - *Example:* \`${ex}\``;
        }
        if (c.firstSeen && c.lastSeen && c.firstSeen !== c.lastSeen) {
            result += `\n  - *Time span:* ${c.firstSeen} → ${c.lastSeen}`;
        }
        return result;
    };

    const criticalAnomalies = anomalies.filter(a => a.severity === 'CRITICAL');
    const errorAnomalies = anomalies.filter(a => a.severity === 'ERROR');
    const warningAnomalies = anomalies.filter(a => a.severity === 'WARNING');
    const securityIssues = anomalies.filter(a => a.category === 'security');
    const perfIssues = anomalies.filter(a => a.category === 'performance');

    // Find error spikes
    const sortedBuckets = [...timeSeries.values()].sort((a, b) => b.errors - a.errors);
    const errorSpikes = sortedBuckets.filter(b => b.errors > 0).slice(0, 5);

    return `
# 🧠 Intelligent Post-Mortem Report

**Log File:** ${path.basename(logFile)}
**Analysis Date:** ${new Date().toISOString()}

## 📊 Summary

| Metric | Value |
|--------|-------|
| Total Lines | ${stats.totalLines.toLocaleString()} |
| Unique Patterns | ${stats.clusterCount} |
| Time Span | ${stats.timeSpanMinutes} minutes |
| Peak Activity | ${stats.peakMinute || 'N/A'} (${stats.peakCount} events) |

### Issue Breakdown

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${anomalies.filter(a => a.severity === 'CRITICAL').reduce((s, a) => s + a.count, 0)} |
| 🟠 Error | ${anomalies.filter(a => a.severity === 'ERROR').reduce((s, a) => s + a.count, 0)} |
| 🟡 Warning | ${anomalies.filter(a => a.severity === 'WARNING').reduce((s, a) => s + a.count, 0)} |

## 🔴 Critical Issues (${criticalAnomalies.length})
${criticalAnomalies.length > 0 ? criticalAnomalies.map(c => formatCluster(c)).join('\n') : '_None detected_'}

## 🟠 Errors (${errorAnomalies.length})
${errorAnomalies.length > 0 ? errorAnomalies.slice(0, 10).map(c => formatCluster(c)).join('\n') : '_None detected_'}
${errorAnomalies.length > 10 ? `\n_...and ${errorAnomalies.length - 10} more_` : ''}

## 🔒 Security Concerns (${securityIssues.length})
${securityIssues.length > 0 ? securityIssues.map(c => formatCluster(c)).join('\n') : '_None detected_'}

## ⚡ Performance Issues (${perfIssues.length})
${perfIssues.length > 0 ? perfIssues.map(c => formatCluster(c)).join('\n') : '_None detected_'}

## 📈 Error Spikes
${errorSpikes.length > 0 ? errorSpikes.map(b => `- **${b.timestamp}**: ${b.errors} errors / ${b.total} total`).join('\n') : '_No significant error spikes_'}

## 📉 Top Patterns (Noise)
${patterns.slice(0, 5).map(c => `- **[${c.count}x]** \`${c.signature.substring(0, 80)}...\``).join('\n')}

---

## 🤖 Agentic Analysis Prompt

Use this prompt with the TOON data for deeper analysis:

> "Analyze the 'anomalies' array. Correlate timestamps in 'dynamicData' to identify:
> 1. The sequence of events leading to errors
> 2. Common request IDs or user IDs across failures  
> 3. Time windows with clustered issues
> 4. Root cause hypothesis based on error patterns"

`.trim();
}

// ============================================
// WORKFLOW DEFINITION
// ============================================

export const workflow: WorkflowDefinition = {
    name: 'post-mortem',

    description: `Intelligent log analysis with pattern clustering and anomaly detection |
USAGE: Parses log files, clusters similar messages by signature, extracts dynamic data
(timestamps, IDs, IPs), identifies anomalies and errors, and generates an actionable report.
EXAMPLE: "Analyze application logs from the outage and find the root cause"
PARAMETERS:
- logFile: Path to the log file to analyze (required)
- outputFile: Path to save TOON-compressed analysis (required)
- maxExamples: Max example lines per cluster (optional, default: 5)
- includePatterns: Include normal patterns in output (optional, default: true)
REQUIRES: filesystem access
NOTES: Supports large files via streaming. Auto-detects log levels and categories.`,

    parameters: {
        logFile: {
            type: 'string',
            description: 'Path to the log file to analyze',
            required: true
        },
        outputFile: {
            type: 'string',
            description: 'Path to save TOON-compressed analysis data',
            required: true
        },
        maxExamples: {
            type: 'number',
            description: 'Maximum example lines to keep per cluster',
            required: false,
            default: 5
        },
        includePatterns: {
            type: 'boolean',
            description: 'Include normal patterns in output',
            required: false,
            default: true
        }
    },

    async execute(params, context) {
        const {
            logFile,
            outputFile,
            maxExamples = 5,
            includePatterns = true
        } = params;

        const errors: string[] = [];

        // ========================================
        // STEP 1: Progress logging setup
        // ========================================
        const totalSteps = 5;
        let currentStep = 1;

        const logProgress = async (message: string) => {
            console.error(`[post-mortem] [${currentStep}/${totalSteps}] ${message}`);
            if (context.servers['sequential-thinking']) {
                await safeExecute(
                    () => context.servers['sequential-thinking'].sequentialthinking({
                        thought: message,
                        thoughtNumber: currentStep,
                        totalThoughts: totalSteps,
                        nextThoughtNeeded: currentStep < totalSteps
                    }),
                    'thinking'
                );
            }
            currentStep++;
        };

        await logProgress(`Starting analysis of ${logFile}`);

        // ========================================
        // STEP 2: Validate input file
        // ========================================
        await logProgress('Validating input file...');

        const absoluteLogPath = path.resolve(process.cwd(), logFile);
        const fileCheck = await validateFile(absoluteLogPath);

        if (!fileCheck.valid) {
            return {
                success: false,
                data: null,
                errors: [fileCheck.error!],
                stats: { attempted: 0, successful: 0, failed: 1 }
            };
        }

        const fileSizeMB = (fileCheck.size! / (1024 * 1024)).toFixed(2);
        console.error(`[post-mortem] File size: ${fileSizeMB} MB`);

        // ========================================
        // STEP 3: Stream and analyze log lines
        // ========================================
        await logProgress(`Analyzing log file (${fileSizeMB} MB)...`);

        const clusters = new Map<string, LogCluster>();
        const timeSeries = new Map<string, TimeSeriesBucket>();
        let lineNumber = 0;
        let emptyLines = 0;
        let globalFirstSeen: string | null = null;
        let globalLastSeen: string | null = null;

        try {
            const fileStream = createReadStream(absoluteLogPath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                lineNumber++;

                if (line.trim().length === 0) {
                    emptyLines++;
                    continue;
                }

                const { signature, severity, category, dynamicData } = analyzeLogLine(line);

                // Get or create cluster
                let cluster = clusters.get(signature);
                if (!cluster) {
                    cluster = {
                        signature,
                        count: 0,
                        severity,
                        category,
                        examples: [],
                        dynamicData: {},
                        firstSeen: null,
                        lastSeen: null,
                        lineNumbers: []
                    };
                    clusters.set(signature, cluster);
                }

                // Update cluster
                cluster.count++;

                // Escalate severity if needed
                const severityOrder = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
                if (severityOrder.indexOf(severity) > severityOrder.indexOf(cluster.severity)) {
                    cluster.severity = severity;
                }

                // Keep examples
                if (cluster.examples.length < maxExamples) {
                    cluster.examples.push(line);
                }

                // Keep some line numbers for reference
                if (cluster.lineNumbers.length < 20) {
                    cluster.lineNumbers.push(lineNumber);
                }

                // Merge dynamic data
                cluster.dynamicData = mergeDynamicData(cluster.dynamicData, dynamicData);

                // Track timestamps
                const timestamp = dynamicData.timestamps?.[0];
                if (timestamp) {
                    if (!cluster.firstSeen) cluster.firstSeen = timestamp;
                    cluster.lastSeen = timestamp;

                    if (!globalFirstSeen) globalFirstSeen = timestamp;
                    globalLastSeen = timestamp;

                    // Time series bucket (minute granularity)
                    const bucket = timestamp.substring(0, 16);
                    let ts = timeSeries.get(bucket);
                    if (!ts) {
                        ts = { timestamp: bucket, total: 0, errors: 0, warnings: 0 };
                        timeSeries.set(bucket, ts);
                    }
                    ts.total++;
                    if (severity === 'ERROR' || severity === 'CRITICAL') ts.errors++;
                    if (severity === 'WARNING') ts.warnings++;
                }

                // Progress update every 100k lines
                if (lineNumber % 100000 === 0) {
                    console.error(`[post-mortem] Processed ${lineNumber.toLocaleString()} lines...`);
                }
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`[file_read] ${message}`);
        }

        // ========================================
        // STEP 4: Classify and sort clusters
        // ========================================
        await logProgress(`Classifying ${clusters.size} patterns...`);

        const allClusters = [...clusters.values()].sort((a, b) => b.count - a.count);

        // Anomalies: rare events OR errors/warnings
        const anomalies = allClusters.filter(c =>
            c.count < 5 ||
            c.severity === 'CRITICAL' ||
            c.severity === 'ERROR' ||
            c.severity === 'WARNING' ||
            c.category === 'security'
        ).sort((a, b) => {
            // Sort by severity first, then count
            const severityOrder = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3, DEBUG: 4 };
            const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
            return sevDiff !== 0 ? sevDiff : b.count - a.count;
        });

        // Normal patterns (high frequency, not errors)
        const patterns = allClusters.filter(c =>
            c.count >= 5 &&
            c.severity !== 'CRITICAL' &&
            c.severity !== 'ERROR' &&
            c.category === 'normal'
        );

        // Find peak activity
        let peakMinute: string | null = null;
        let peakCount = 0;
        for (const [bucket, ts] of timeSeries) {
            if (ts.total > peakCount) {
                peakCount = ts.total;
                peakMinute = bucket;
            }
        }

        // Build stats
        const stats: AnalysisStats = {
            totalLines: lineNumber,
            emptyLines,
            clusterCount: clusters.size,
            anomalyCount: anomalies.length,
            errorCount: anomalies.filter(a => a.severity === 'ERROR' || a.severity === 'CRITICAL').reduce((s, a) => s + a.count, 0),
            warningCount: anomalies.filter(a => a.severity === 'WARNING').reduce((s, a) => s + a.count, 0),
            timeSpanMinutes: getTimeSpanMinutes(globalFirstSeen, globalLastSeen),
            peakMinute,
            peakCount
        };

        // ========================================
        // STEP 5: Generate output and save
        // ========================================
        await logProgress('Generating report and saving...');

        const report = generateReport(logFile, stats, anomalies, patterns, timeSeries);

        const outputData = {
            report,
            timestamp: new Date().toISOString(),
            logFile: path.basename(logFile),
            stats,
            timeSeries: Object.fromEntries(timeSeries),
            anomalies,
            patterns: includePatterns ? patterns.slice(0, 30) : undefined
        };

        // TOON-encode
        const toonData = context.encode(outputData);

        // Save to file
        const absoluteOutputPath = path.resolve(process.cwd(), outputFile);
        const writeResult = await safeExecute(
            () => fs.writeFile(absoluteOutputPath, toonData, 'utf-8'),
            'file_write'
        );

        if (writeResult.error) {
            errors.push(writeResult.error);
        } else {
            console.error(`[post-mortem] ✓ Saved to ${absoluteOutputPath}`);
        }

        // Return structured result
        return {
            success: errors.length === 0,
            data: toonData,
            report, // Include readable report for immediate display
            stats: {
                ...stats,
                fileSaved: !writeResult.error,
                outputSize: toonData.length
            },
            errors: errors.length > 0 ? errors : undefined
        };
    }
};