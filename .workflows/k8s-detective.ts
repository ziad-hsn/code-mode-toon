import type { WorkflowDefinition } from '../src/workflow-types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const workflow: WorkflowDefinition = {
    name: 'k8s-detective',
    description: 'Audits a Kubernetes cluster for security risks, resource efficiency, and stability issues.',
    parameters: {
        outputFile: {
            type: 'string',
            description: 'Path to save the TOON-compressed cluster data.',
            required: true
        },
        namespace: {
            type: 'string',
            description: 'Namespace to scan (default: all namespaces)',
            required: false,
            default: ''
        }
    },
    execute: async (params: { outputFile: string, namespace?: string }, context) => {
        const { outputFile, namespace } = params;
        const nsFlag = namespace ? `-n ${namespace}` : '-A';

        console.error(`[K8s Detective] Scanning cluster (Namespace: ${namespace || 'ALL'})...`);

        try {
            // Fetch cluster data using kubectl directly
            const { stdout: podsJson } = await execAsync(`kubectl get pods ${nsFlag} -o json`);
            const { stdout: deployJson } = await execAsync(`kubectl get deployments ${nsFlag} -o json`);

            const pods = JSON.parse(podsJson).items;
            const deployments = JSON.parse(deployJson).items;

            console.error(`[K8s Detective] Analyzed ${pods.length} pods and ${deployments.length} deployments.`);

            // Heuristic Analysis
            const issues: string[] = [];
            let privilegedCount = 0;
            let noLimitsCount = 0;
            let crashLoopCount = 0;

            for (const pod of pods) {
                const name = pod.metadata?.name || 'unknown';
                const ns = pod.metadata?.namespace || 'default';

                const containers = pod.spec?.containers || [];
                for (const c of containers) {
                    if (c.securityContext?.privileged) {
                        issues.push(`[SECURITY] Pod ${ns}/${name} has privileged container: ${c.name}`);
                        privilegedCount++;
                    }
                    if (!c.resources?.limits) {
                        noLimitsCount++;
                    }
                }

                const statuses = pod.status?.containerStatuses || [];
                for (const s of statuses) {
                    if (s.state?.waiting?.reason === 'CrashLoopBackOff' || (s.restartCount && s.restartCount > 5)) {
                        issues.push(`[STABILITY] Pod ${ns}/${name} is crashing (Restarts: ${s.restartCount})`);
                        crashLoopCount++;
                    }
                }
            }

            // Generate Report
            const report = `
# 🕵️‍♂️ K8s Detective Audit Report

**Date:** ${new Date().toISOString()}
**Scope:** ${namespace || 'All Namespaces'}

## 📊 Summary
- **Total Pods:** ${pods.length}
- **Total Deployments:** ${deployments.length}
- **Security Risks:** ${privilegedCount}
- **Efficiency Issues:** ${noLimitsCount} pods without limits
- **Stability Issues:** ${crashLoopCount} crashing pods

## 🚨 Findings
${issues.length > 0 ? issues.map(i => `- ${i}`).join('\n') : '✅ No major issues found!'}

## 📦 Raw Data
See attached TOON file for full cluster state.
`;

            // Compress Data (TOON)
            const outputData = {
                report,
                timestamp: new Date().toISOString(),
                stats: {
                    pods: pods.length,
                    deployments: deployments.length,
                    issues: issues.length,
                    privileged: privilegedCount,
                    noLimits: noLimitsCount,
                    crashLoops: crashLoopCount
                },
                raw_pods: pods.map((p: any) => ({
                    name: p.metadata?.name,
                    namespace: p.metadata?.namespace,
                    status: p.status?.phase,
                    restarts: p.status?.containerStatuses?.reduce((acc: number, s: any) => acc + (s.restartCount || 0), 0) || 0,
                    containers: p.spec?.containers?.map((c: any) => ({
                        name: c.name,
                        image: c.image,
                        privileged: c.securityContext?.privileged || false,
                        hasLimits: !!c.resources?.limits
                    }))
                })),
                raw_deployments: deployments.map((d: any) => ({
                    name: d.metadata?.name,
                    namespace: d.metadata?.namespace,
                    replicas: d.spec?.replicas,
                    available: d.status?.availableReplicas
                }))
            };

            const toonData = context.encode(outputData);

            // Save Output
            // Resolve path against CWD (which should be the project root)
            const absolutePath = path.resolve(process.cwd(), outputFile);
            await fs.writeFile(absolutePath, toonData, 'utf-8');
            console.error(`[K8s Detective] ✓ TOON data saved to ${absolutePath}`);

            // Return the TOON data directly to the LLM so it can analyze it
            return toonData;

        } catch (error: any) {
            console.error('[K8s Detective] Error:', error);
            throw new Error(`Failed to scan cluster: ${error.message}`);
        }
    }
};
