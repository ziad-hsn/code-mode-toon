import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkflowDefinition, WorkflowContext } from '../workflow-types.js';
import { ConfigManager } from './config-manager.js';
import { MCPServerManager } from './mcp-server-manager.js';
import { PathNormalizer } from './path-normalizer.js';
import { TOONEncoder } from '../toon-encoder.js';

export class WorkflowManager {
    private workflows: Map<string, WorkflowDefinition> = new Map();

    constructor(
        private configManager: ConfigManager,
        private serverManager: MCPServerManager,
        private pathNormalizer: PathNormalizer
    ) { }

    async loadWorkflows(): Promise<void> {
        // Check for WORKFLOWS_DIR env variable, default to .workflows
        const workflowDirName = process.env.WORKFLOWS_DIR || '.workflows';
        const projectRoot = this.configManager.getProjectRoot();
        const primaryDir = path.join(projectRoot, 'dist', workflowDirName);
        const moduleDir = path.dirname(fileURLToPath(import.meta.url));
        const packageDir = path.join(moduleDir, '..', workflowDirName);

        const candidates = [primaryDir, packageDir].filter((dir, idx, arr) => arr.indexOf(dir) === idx);
        const workflowDir = candidates.find(dir => fs.existsSync(dir));

        if (!workflowDir) {
            console.error(`[CodeMode+TOON] Workflow directory not found at ${primaryDir} or ${packageDir}. Skipping workflow loading.`);
            console.error(`[CodeMode+TOON] Set WORKFLOWS_DIR environment variable to customize the workflows directory name.`);
            return;
        }

        if (workflowDir === packageDir && !fs.existsSync(primaryDir)) {
            console.error(`[CodeMode+TOON] Using packaged workflows at ${workflowDir} (no project-level workflows found).`);
        }

        const files = fs.readdirSync(workflowDir)
            .filter(f => f.endsWith('.js') && f !== 'workflow-template.js');

        console.error(`[CodeMode+TOON] Loading workflows from ${workflowDir}...`);

        for (const file of files) {
            try {
                const modulePath = path.join(workflowDir, file);
                // Dynamic import requires a file URL on Windows or absolute path
                const importPath = process.platform === 'win32' ? `file://${modulePath}` : modulePath;
                const module = await import(importPath);

                if (module.workflow && this.validateWorkflow(module.workflow)) {
                    this.workflows.set(module.workflow.name, module.workflow);
                    console.error(`[CodeMode+TOON] ✓ Loaded workflow: ${module.workflow.name}`);
                } else {
                    console.error(`[CodeMode+TOON] ⚠ Skipped invalid workflow file: ${file} (missing export const workflow = ...)`);
                }
            } catch (error: any) {
                console.error(`[CodeMode+TOON] ✗ Failed to load ${file}:`, error.message);
            }
        }
    }

    private validateWorkflow(wf: any): boolean {
        return !!(wf.name && wf.description && wf.parameters && wf.execute);
    }

    getWorkflow(name: string): WorkflowDefinition | undefined {
        return this.workflows.get(name);
    }

    listWorkflows(): Array<{ name: string; description: string; parameters: any }> {
        return Array.from(this.workflows.values()).map(w => ({
            name: w.name,
            description: w.description,
            parameters: w.parameters
        }));
    }

    async executeWorkflow(name: string, params: any): Promise<any> {
        const workflow = this.workflows.get(name);
        if (!workflow) {
            throw new Error(`Workflow '${name}' not found`);
        }

        // Validate parameters with helpful error messages
        const missingParams: string[] = [];
        for (const [key, def] of Object.entries(workflow.parameters)) {
            if (def.required && params[key] === undefined) {
                missingParams.push(key);
            }
        }

        if (missingParams.length > 0) {
            const exampleParams: Record<string, any> = {};
            for (const [key, def] of Object.entries(workflow.parameters)) {
                if (def.required) {
                    exampleParams[key] = def.description || `<${def.type}>`;
                }
            }

            const usageExample = JSON.stringify({
                workflowName: name,
                parameters: exampleParams
            }, null, 2);

            throw new Error(
                `Missing required parameter${missingParams.length > 1 ? 's' : ''}: ${missingParams.join(', ')}\n\n` +
                `CORRECT USAGE:\n${usageExample}\n\n` +
                `WORKFLOW: ${workflow.description}`
            );
        }

        // Build Context
        const serverNames = new Set<string>([
            ...this.serverManager.getLoadedServers().keys(),
            ...this.serverManager.getLazyServers()
        ]);

        const serversAPI: Record<string, any> = {};
        for (const serverName of serverNames) {
            serversAPI[serverName] = new Proxy({}, {
                get: (_target, prop) => {
                    if (prop === "then" || typeof prop !== "string") return undefined;
                    return async (rawArgs: any) => {
                        const server = await this.serverManager.ensureServerLoaded(serverName);
                        const tool = server.tools.find((t) => t.name === prop);
                        if (!tool) throw new Error(`Tool "${prop}" not found on server "${serverName}"`);
                        const args = this.pathNormalizer.normalizeArguments(rawArgs);
                        const result = await server.call(tool.name, args);
                        return this.unwrapMCPResult(result);
                    };
                }
            });
        }

        const context: WorkflowContext = {
            servers: serversAPI,
            encode: (data: any) => TOONEncoder.encode(data)
        };

        return await workflow.execute(params, context);
    }

    private unwrapMCPResult(result: any): any {
        let unwrapped = result;
        if (result && result.content && Array.isArray(result.content)) {
            if (result.content.length === 1 && result.content[0].type === "text") {
                unwrapped = result.content[0].text;
            } else {
                unwrapped = result.content.map((c: any) => c.text || c).join('\n');
            }
        }
        if (result && result._toon && result._compressed) {
            try {
                unwrapped = TOONEncoder.decode(result._compressed);
            } catch {
                unwrapped = result._compressed;
            }
        }
        return this.pathNormalizer.normalizePathsInResult(unwrapped);
    }
}
