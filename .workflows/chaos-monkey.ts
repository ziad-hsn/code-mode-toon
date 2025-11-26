import { WorkflowDefinition } from '../src/workflow-types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const workflow: WorkflowDefinition = {
    name: 'chaos-monkey',
    description: 'Tests system resilience by randomly stopping a Docker container and checking for recovery.',
    parameters: {
        outputFile: {
            type: 'string',
            description: 'Path to save the chaos report.',
            required: true
        },
        dryRun: {
            type: 'boolean',
            description: 'If true, only simulates the attack.',
            required: false,
            default: false
        },
        exclude: {
            type: 'array',
            description: 'List of container names to exclude from attacks.',
            required: false,
            default: []
        }
    },
    execute: async (params: { outputFile: string, dryRun?: boolean, exclude?: string[] }, context) => {
        const { outputFile, dryRun, exclude = [] } = params;

        console.error(`[Chaos Monkey] Starting chaos experiment (DryRun: ${dryRun})...`);

        try {
            // 1. List Containers
            const { stdout } = await execAsync('docker ps --format "{{.ID}}|{{.Names}}|{{.Status}}"');
            const containers = stdout.trim().split('\n').map(line => {
                const [id, name, status] = line.split('|');
                return { id, name, status };
            }).filter(c => c.id); // Filter empty lines

            if (containers.length === 0) {
                throw new Error('No running containers found to attack!');
            }

            // 2. Select Target
            const candidates = containers.filter(c => !exclude.includes(c.name));
            if (candidates.length === 0) {
                throw new Error('No candidates available after exclusion.');
            }

            const target = candidates[Math.floor(Math.random() * candidates.length)];
            console.error(`[Chaos Monkey] Selected target: ${target.name} (${target.id})`);

            // 3. Attack!
            let attackLog = '';
            if (!dryRun) {
                console.error(`[Chaos Monkey] 🔫 Stopping container ${target.name}...`);
                await execAsync(`docker stop ${target.id}`);
                attackLog = `Stopped container ${target.name} (${target.id})`;
            } else {
                console.error(`[Chaos Monkey] 🔫 (SIMULATION) Would stop container ${target.name}...`);
                attackLog = `(DryRun) Would stop container ${target.name} (${target.id})`;
            }

            // 4. Monitor Recovery
            console.error('[Chaos Monkey] Waiting 10s for recovery...');
            await sleep(10000);

            // Check status
            const { stdout: checkStdout } = await execAsync(`docker ps --filter "id=${target.id}" --format "{{.Status}}"`);
            const isRunning = checkStdout.includes('Up');

            // 5. Generate Report
            const report = `
# 🐒 Chaos Monkey Report

**Date:** ${new Date().toISOString()}
**Mode:** ${dryRun ? 'Dry Run' : 'Live Fire'}

## 🎯 Target
- **Name:** ${target.name}
- **ID:** ${target.id}
- **Initial Status:** ${target.status}

## 💥 Attack
- **Action:** Docker Stop
- **Log:** ${attackLog}

## 🏥 Recovery Status
- **Status after 10s:** ${isRunning ? '✅ UP (Recovered/Restarted)' : '❌ DOWN (Failed to recover)'}
- **Verdict:** ${isRunning ? 'RESILIENT' : 'VULNERABLE'}

## 📝 Notes
${isRunning ? 'The system successfully detected the failure and restarted the container (or it was manually restarted).' : 'The container did not restart automatically. Check restart policies (docker run --restart always).'}
`;

            // 6. Compress Output
            const outputData = {
                report,
                experiment: {
                    target: target.name,
                    action: 'stop',
                    recovered: isRunning
                }
            };

            const toonData = context.encode(outputData);
            await fs.writeFile(outputFile, toonData, 'utf-8');

            return report;

        } catch (error: any) {
            console.error('[Chaos Monkey] Error:', error);
            throw new Error(`Chaos experiment failed: ${error.message}`);
        }
    }
};
