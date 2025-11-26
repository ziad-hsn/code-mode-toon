import type { WorkflowDefinition } from '../src/workflow-types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Helper: Mask dynamic parts of a log line to create a signature
function getLogSignature(line: string): { signature: string, dynamicData: Record<string, string> } {
    const dynamicData: Record<string, string> = {};
    let signature = line;

    // 1. Mask Timestamps (ISO-like)
    // 2023-10-27T10:00:00.000Z or 2023-10-27 10:00:00
    const timeRegex = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
    const timeMatch = signature.match(timeRegex);
    if (timeMatch) {
        dynamicData['timestamp'] = timeMatch[0];
        signature = signature.replace(timeRegex, '<TIME>');
    }

    // 2. Mask UUIDs
    // 3859a8b4-1234-4567-890a-1234567890ab
    const uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
    let uuidCount = 0;
    signature = signature.replace(uuidRegex, (match) => {
        const key = `uuid_${uuidCount++}`;
        dynamicData[key] = match;
        return '<UUID>';
    });

    // 3. Mask IPs (IPv4)
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    let ipCount = 0;
    signature = signature.replace(ipRegex, (match) => {
        // Skip version numbers like 1.0.0 if possible, but hard to distinguish without context
        const key = `ip_${ipCount++}`;
        dynamicData[key] = match;
        return '<IP>';
    });

    // 4. Mask Hex/Numbers (that look like IDs, not small integers)
    // 0x1234 or large numbers
    const hexRegex = /0x[0-9a-fA-F]+/g;
    signature = signature.replace(hexRegex, '<HEX>');

    // 5. Mask generic numbers at end of line (often latency or IDs)
    // But keep small numbers (status codes?) - heuristic: > 3 digits
    // Actually, masking all numbers is safer for clustering, but might lose status codes.
    // Let's mask numbers > 1000 or attached to words

    return { signature, dynamicData };
}

export const workflow: WorkflowDefinition = {
    name: 'post-mortem',
    description: 'Intelligent log analysis that clusters patterns and preserves data for LLM reasoning.',
    parameters: {
        logFile: {
            type: 'string',
            description: 'Path to the log file to analyze.',
            required: true
        },
        outputFile: {
            type: 'string',
            description: 'Path to save the structured TOON data.',
            required: true
        }
    },
    execute: async (params: { logFile: string, outputFile: string }, context) => {
        const { logFile, outputFile } = params;
        console.error(`[Post-Mortem] Analyzing ${logFile}...`);

        try {
            const content = await fs.readFile(logFile, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);

            // --- RICH CLUSTERING ---
            const clusters: Record<string, {
                count: number;
                signature: string;
                examples: string[];
                dynamic_data: Record<string, string[]>; // key -> list of values
                first_seen: string | null;
                last_seen: string | null;
            }> = {};

            const timeSeries: Record<string, number> = {}; // Minute-level granularity

            for (const line of lines) {
                const { signature, dynamicData } = getLogSignature(line);

                if (!clusters[signature]) {
                    clusters[signature] = {
                        count: 0,
                        signature,
                        examples: [],
                        dynamic_data: {},
                        first_seen: null,
                        last_seen: null
                    };
                }

                const cluster = clusters[signature];
                cluster.count++;

                // Keep first 5 examples
                if (cluster.examples.length < 5) {
                    cluster.examples.push(line);
                }

                // Store dynamic data
                for (const [key, value] of Object.entries(dynamicData)) {
                    if (!cluster.dynamic_data[key]) cluster.dynamic_data[key] = [];
                    // Limit stored values to avoid explosion, but keep enough for analysis
                    if (cluster.dynamic_data[key].length < 50) {
                        cluster.dynamic_data[key].push(value);
                    }
                }

                // Time tracking
                if (dynamicData['timestamp']) {
                    if (!cluster.first_seen) cluster.first_seen = dynamicData['timestamp'];
                    cluster.last_seen = dynamicData['timestamp'];

                    // Time series bucket (YYYY-MM-DDTHH:MM)
                    const bucket = dynamicData['timestamp'].substring(0, 16);
                    timeSeries[bucket] = (timeSeries[bucket] || 0) + 1;
                }
            }

            // --- ANALYSIS ---
            const clusterList = Object.values(clusters).sort((a, b) => b.count - a.count);

            const anomalies = clusterList.filter(c => c.count < 5 || c.signature.match(/ERROR|FATAL|Exception|EPIPE|Fail|Critical/i));
            const patterns = clusterList.filter(c => c.count >= 5 && !c.signature.match(/ERROR|FATAL|Exception|EPIPE|Fail|Critical/i));

            // Generate Report
            const report = `
# 🧠 Intelligent Post-Mortem Report

**Log File:** ${path.basename(logFile)}
**Analysis Date:** ${new Date().toISOString()}
**Total Lines:** ${lines.length}
**Unique Patterns:** ${clusterList.length}

## 🚨 Anomalies & Errors (${anomalies.length})
These are rare events or explicit errors that require investigation.
${anomalies.map(c => `- **[${c.count}x]** \`${c.signature.substring(0, 100)}\`
  - *Example:* \`${c.examples[0].substring(0, 100)}\``).join('\n')}

## 📉 Frequent Patterns (${patterns.length})
Normal system behavior (noise).
${patterns.slice(0, 5).map(c => `- **[${c.count}x]** \`${c.signature.substring(0, 100)}\``).join('\n')}

## 🤖 Agentic Handoff
The attached TOON file contains the full rich structure.
**Suggested Prompt:**
"Use the 'sequential-thinking' tool to analyze the 'anomalies' in the attached data. Correlate the timestamps in 'dynamic_data' to find the root cause sequence."
`;

            // --- OUTPUT ---
            const outputData = {
                report,
                stats: {
                    total_lines: lines.length,
                    cluster_count: clusterList.length,
                    anomaly_count: anomalies.length
                },
                time_series: timeSeries,
                anomalies: anomalies, // Full rich data
                patterns: patterns.slice(0, 20) // Top 20 patterns to save space
            };

            const toonData = context.encode(outputData);

            // Save Output
            const absolutePath = path.resolve(process.cwd(), outputFile);
            await fs.writeFile(absolutePath, toonData, 'utf-8');
            console.error(`[Post-Mortem] ✓ TOON data saved to ${absolutePath}`);

            return toonData;

        } catch (error: any) {
            console.error('[Post-Mortem] Error:', error);
            throw new Error(`Failed to analyze logs: ${error.message}`);
        }
    }
};
