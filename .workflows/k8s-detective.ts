import type { WorkflowDefinition } from '../src/workflow-types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * WORKFLOW: k8s-detective
 * 
 * Comprehensive Kubernetes cluster security and health auditor.
 * Analyzes pods, deployments, services, events, and network policies
 * for security risks, resource efficiency, and stability issues.
 * 
 * @example
 * execute_workflow({ name: 'k8s-detective', params: { outputFile: './audit.toon' } })
 */

// ============================================
// TYPES
// ============================================

interface K8sMetadata {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
}

interface K8sContainer {
    name: string;
    image: string;
    securityContext?: {
        privileged?: boolean;
        runAsRoot?: boolean;
        allowPrivilegeEscalation?: boolean;
    };
    resources?: {
        limits?: Record<string, string>;
        requests?: Record<string, string>;
    };
}

interface K8sPod {
    metadata: K8sMetadata;
    spec: {
        containers: K8sContainer[];
        hostNetwork?: boolean;
        hostPID?: boolean;
    };
    status: {
        phase: string;
        containerStatuses?: Array<{
            name: string;
            restartCount: number;
            state?: {
                waiting?: { reason: string };
            };
        }>;
    };
}

interface K8sDeployment {
    metadata: K8sMetadata;
    spec: {
        replicas: number;
        strategy?: { type: string };
    };
    status: {
        availableReplicas?: number;
        readyReplicas?: number;
    };
}

interface K8sEvent {
    metadata: K8sMetadata;
    reason: string;
    message: string;
    type: string;
    count?: number;
    involvedObject: {
        kind: string;
        name: string;
        namespace: string;
    };
}

interface AuditIssue {
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    category: 'SECURITY' | 'STABILITY' | 'EFFICIENCY' | 'CONFIG';
    resource: string;
    message: string;
}

interface AuditStats {
    pods: number;
    deployments: number;
    services: number;
    events: number;
    issues: {
        critical: number;
        high: number;
        medium: number;
        low: number;
    };
}

// ============================================
// HELPERS
// ============================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Retry with exponential backoff for transient failures
 */
async function retry<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries = 3,
    baseDelay = 1000
): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err as Error;
            if (attempt < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.error(`[k8s-detective] Retry ${attempt + 1}/${maxRetries} for ${label} in ${delay}ms`);
                await sleep(delay);
            }
        }
    }
    throw lastError;
}

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
 * Execute kubectl command with retry and JSON parsing
 */
async function kubectlGet<T>(
    resource: string,
    nsFlag: string
): Promise<{ items: T[] }> {
    const { stdout } = await retry(
        () => execAsync(`kubectl get ${resource} ${nsFlag} -o json`, { maxBuffer: 50 * 1024 * 1024 }),
        `kubectl get ${resource}`
    );
    return JSON.parse(stdout);
}

/**
 * Check if kubectl is available and connected
 */
async function validateKubectl(): Promise<{ valid: boolean; error?: string }> {
    try {
        await execAsync('kubectl cluster-info --request-timeout=5s 2>/dev/null');
        return { valid: true };
    } catch {
        return { valid: false, error: 'kubectl not available or cluster not reachable' };
    }
}

/**
 * Analyze pod for security issues
 */
function analyzePodSecurity(pod: K8sPod): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const podId = `${pod.metadata.namespace}/${pod.metadata.name}`;

    // Host namespace access
    if (pod.spec.hostNetwork) {
        issues.push({
            severity: 'HIGH',
            category: 'SECURITY',
            resource: podId,
            message: 'Pod uses host network - can intercept host traffic'
        });
    }

    if (pod.spec.hostPID) {
        issues.push({
            severity: 'HIGH',
            category: 'SECURITY',
            resource: podId,
            message: 'Pod uses host PID namespace - can see/kill host processes'
        });
    }

    for (const container of pod.spec.containers) {
        const sc = container.securityContext;
        
        if (sc?.privileged) {
            issues.push({
                severity: 'CRITICAL',
                category: 'SECURITY',
                resource: `${podId}/${container.name}`,
                message: 'Container runs privileged - full host access'
            });
        }

        if (sc?.allowPrivilegeEscalation !== false) {
            issues.push({
                severity: 'MEDIUM',
                category: 'SECURITY',
                resource: `${podId}/${container.name}`,
                message: 'allowPrivilegeEscalation not explicitly disabled'
            });
        }

        // Image security
        if (container.image.includes(':latest') || !container.image.includes(':')) {
            issues.push({
                severity: 'MEDIUM',
                category: 'SECURITY',
                resource: `${podId}/${container.name}`,
                message: `Using :latest or untagged image: ${container.image}`
            });
        }
    }

    return issues;
}

/**
 * Analyze pod for resource efficiency
 */
function analyzePodResources(pod: K8sPod): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const podId = `${pod.metadata.namespace}/${pod.metadata.name}`;

    for (const container of pod.spec.containers) {
        if (!container.resources?.limits) {
            issues.push({
                severity: 'MEDIUM',
                category: 'EFFICIENCY',
                resource: `${podId}/${container.name}`,
                message: 'No resource limits set - can consume unbounded resources'
            });
        }

        if (!container.resources?.requests) {
            issues.push({
                severity: 'LOW',
                category: 'EFFICIENCY',
                resource: `${podId}/${container.name}`,
                message: 'No resource requests - scheduler cannot optimize placement'
            });
        }
    }

    return issues;
}

/**
 * Analyze pod for stability issues
 */
function analyzePodStability(pod: K8sPod): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const podId = `${pod.metadata.namespace}/${pod.metadata.name}`;

    for (const status of pod.status.containerStatuses || []) {
        if (status.state?.waiting?.reason === 'CrashLoopBackOff') {
            issues.push({
                severity: 'HIGH',
                category: 'STABILITY',
                resource: `${podId}/${status.name}`,
                message: `CrashLoopBackOff - ${status.restartCount} restarts`
            });
        } else if (status.restartCount > 5) {
            issues.push({
                severity: 'MEDIUM',
                category: 'STABILITY',
                resource: `${podId}/${status.name}`,
                message: `High restart count: ${status.restartCount}`
            });
        }
    }

    if (pod.status.phase === 'Pending') {
        issues.push({
            severity: 'MEDIUM',
            category: 'STABILITY',
            resource: podId,
            message: 'Pod stuck in Pending state'
        });
    }

    return issues;
}

/**
 * Analyze deployment health
 */
function analyzeDeployment(deployment: K8sDeployment): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const deployId = `${deployment.metadata.namespace}/${deployment.metadata.name}`;

    const desired = deployment.spec.replicas;
    const available = deployment.status.availableReplicas || 0;

    if (available < desired) {
        issues.push({
            severity: 'HIGH',
            category: 'STABILITY',
            resource: deployId,
            message: `Degraded: ${available}/${desired} replicas available`
        });
    }

    if (desired === 1) {
        issues.push({
            severity: 'LOW',
            category: 'CONFIG',
            resource: deployId,
            message: 'Single replica - no high availability'
        });
    }

    return issues;
}

/**
 * Analyze events for warnings
 */
function analyzeEvents(events: K8sEvent[]): AuditIssue[] {
    const issues: AuditIssue[] = [];
    
    // Count repeated warnings
    const warningCounts = new Map<string, number>();
    
    for (const event of events) {
        if (event.type === 'Warning') {
            const key = `${event.involvedObject.kind}/${event.involvedObject.namespace}/${event.involvedObject.name}:${event.reason}`;
            warningCounts.set(key, (warningCounts.get(key) || 0) + (event.count || 1));
        }
    }

    for (const [key, count] of warningCounts) {
        if (count >= 3) {
            const [resource, reason] = key.split(':');
            issues.push({
                severity: count >= 10 ? 'HIGH' : 'MEDIUM',
                category: 'STABILITY',
                resource,
                message: `Repeated warning (${count}x): ${reason}`
            });
        }
    }

    return issues;
}

/**
 * Generate markdown report from audit results
 */
function generateReport(
    namespace: string,
    stats: AuditStats,
    issues: AuditIssue[]
): string {
    const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
    const highIssues = issues.filter(i => i.severity === 'HIGH');
    const mediumIssues = issues.filter(i => i.severity === 'MEDIUM');
    const lowIssues = issues.filter(i => i.severity === 'LOW');

    const formatIssues = (list: AuditIssue[]) =>
        list.length > 0
            ? list.map(i => `- **[${i.category}]** \`${i.resource}\`: ${i.message}`).join('\n')
            : '_None_';

    return `
# 🕵️ K8s Detective Audit Report

**Timestamp:** ${new Date().toISOString()}
**Scope:** ${namespace || 'All Namespaces'}

## 📊 Cluster Overview

| Resource | Count |
|----------|-------|
| Pods | ${stats.pods} |
| Deployments | ${stats.deployments} |
| Services | ${stats.services} |
| Events Analyzed | ${stats.events} |

## 🚨 Issue Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${stats.issues.critical} |
| 🟠 High | ${stats.issues.high} |
| 🟡 Medium | ${stats.issues.medium} |
| 🟢 Low | ${stats.issues.low} |

## 🔴 Critical Issues
${formatIssues(criticalIssues)}

## 🟠 High Severity
${formatIssues(highIssues)}

## 🟡 Medium Severity
${formatIssues(mediumIssues)}

## 🟢 Low Severity
${formatIssues(lowIssues)}

---
*Generated by k8s-detective workflow*
`.trim();
}

// ============================================
// WORKFLOW DEFINITION
// ============================================

export const workflow: WorkflowDefinition = {
    name: 'k8s-detective',

    description: `Comprehensive Kubernetes cluster security and health auditor |
USAGE: Scans pods, deployments, services, and events for security vulnerabilities,
resource inefficiencies, and stability issues. Outputs detailed findings with severity ratings.
EXAMPLE: "Audit my production cluster for security risks"
PARAMETERS:
- outputFile: Path to save TOON-compressed audit data (required)
- namespace: Specific namespace to scan (optional, default: all)
- includeEvents: Analyze recent events for warnings (optional, default: true)
REQUIRES: kubectl configured with cluster access
NOTES: Requires kubectl in PATH. Large clusters auto-TOON-encode. Run from bastion or local with kubeconfig.`,

    parameters: {
        outputFile: {
            type: 'string',
            description: 'Path to save TOON-compressed cluster audit data',
            required: true
        },
        namespace: {
            type: 'string',
            description: 'Namespace to scan (default: all namespaces)',
            required: false,
            default: ''
        },
        includeEvents: {
            type: 'boolean',
            description: 'Include recent events analysis',
            required: false,
            default: true
        }
    },

    async execute(params, context) {
        const { outputFile, namespace = '', includeEvents = true } = params;
        const nsFlag = namespace ? `-n ${namespace}` : '-A';
        const errors: string[] = [];
        const allIssues: AuditIssue[] = [];

        // ========================================
        // STEP 1: Progress logging setup
        // ========================================
        const totalSteps = includeEvents ? 6 : 5;
        let currentStep = 1;

        const logProgress = async (message: string) => {
            console.error(`[k8s-detective] [${currentStep}/${totalSteps}] ${message}`);
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

        await logProgress(`Starting audit (scope: ${namespace || 'ALL'})`);

        // ========================================
        // STEP 2: Validate kubectl
        // ========================================
        await logProgress('Validating kubectl connection...');
        
        const kubectlCheck = await validateKubectl();
        if (!kubectlCheck.valid) {
            return {
                success: false,
                data: null,
                errors: [kubectlCheck.error!],
                stats: { attempted: 0, successful: 0, failed: 1 }
            };
        }

        // ========================================
        // STEP 3: Parallel data fetching
        // ========================================
        await logProgress('Fetching cluster resources (parallel)...');

        const [podsResult, deploymentsResult, servicesResult, eventsResult] = await Promise.all([
            safeExecute(() => kubectlGet<K8sPod>('pods', nsFlag), 'pods'),
            safeExecute(() => kubectlGet<K8sDeployment>('deployments', nsFlag), 'deployments'),
            safeExecute(() => kubectlGet<{ metadata: K8sMetadata }>('services', nsFlag), 'services'),
            includeEvents
                ? safeExecute(() => kubectlGet<K8sEvent>('events', nsFlag), 'events')
                : Promise.resolve({ data: { items: [] as K8sEvent[] }, error: null })
        ]);

        // Collect errors but continue with available data
        const pods = podsResult.data?.items || [];
        const deployments = deploymentsResult.data?.items || [];
        const services = servicesResult.data?.items || [];
        const events = eventsResult.data?.items || [];

        if (podsResult.error) errors.push(podsResult.error);
        if (deploymentsResult.error) errors.push(deploymentsResult.error);
        if (servicesResult.error) errors.push(servicesResult.error);
        if (eventsResult.error) errors.push(eventsResult.error);

        // ========================================
        // STEP 4: Analysis
        // ========================================
        await logProgress(`Analyzing ${pods.length} pods, ${deployments.length} deployments...`);

        // Analyze pods
        for (const pod of pods) {
            allIssues.push(...analyzePodSecurity(pod));
            allIssues.push(...analyzePodResources(pod));
            allIssues.push(...analyzePodStability(pod));
        }

        // Analyze deployments
        for (const deployment of deployments) {
            allIssues.push(...analyzeDeployment(deployment));
        }

        // Analyze events
        if (includeEvents && events.length > 0) {
            allIssues.push(...analyzeEvents(events));
        }

        // ========================================
        // STEP 5: Generate report
        // ========================================
        await logProgress('Generating audit report...');

        const stats: AuditStats = {
            pods: pods.length,
            deployments: deployments.length,
            services: services.length,
            events: events.length,
            issues: {
                critical: allIssues.filter(i => i.severity === 'CRITICAL').length,
                high: allIssues.filter(i => i.severity === 'HIGH').length,
                medium: allIssues.filter(i => i.severity === 'MEDIUM').length,
                low: allIssues.filter(i => i.severity === 'LOW').length
            }
        };

        const report = generateReport(namespace, stats, allIssues);

        // Build output data
        const outputData = {
            report,
            timestamp: new Date().toISOString(),
            scope: namespace || 'all-namespaces',
            stats,
            issues: allIssues,
            raw: {
                pods: pods.map(p => ({
                    name: p.metadata.name,
                    namespace: p.metadata.namespace,
                    status: p.status.phase,
                    restarts: p.status.containerStatuses?.reduce((acc, s) => acc + s.restartCount, 0) || 0,
                    containers: p.spec.containers.map(c => ({
                        name: c.name,
                        image: c.image,
                        privileged: c.securityContext?.privileged || false,
                        hasLimits: !!c.resources?.limits
                    }))
                })),
                deployments: deployments.map(d => ({
                    name: d.metadata.name,
                    namespace: d.metadata.namespace,
                    replicas: d.spec.replicas,
                    available: d.status.availableReplicas || 0
                }))
            }
        };

        // ========================================
        // STEP 6: Save and return
        // ========================================
        await logProgress('Saving audit results...');

        // TOON-encode for compression
        const toonData = context.encode(outputData);

        // Save to file
        const absolutePath = path.resolve(process.cwd(), outputFile);
        const writeResult = await safeExecute(
            () => fs.writeFile(absolutePath, toonData, 'utf-8'),
            'file_write'
        );

        if (writeResult.error) {
            errors.push(writeResult.error);
        } else {
            console.error(`[k8s-detective] ✓ Saved to ${absolutePath}`);
        }

        // Return structured result
        return {
            success: errors.length === 0,
            data: toonData,
            report, // Include readable report for immediate display
            stats: {
                ...stats,
                totalIssues: allIssues.length,
                fileSaved: !writeResult.error
            },
            errors: errors.length > 0 ? errors : undefined
        };
    }
};
