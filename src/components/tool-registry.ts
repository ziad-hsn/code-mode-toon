import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ConfigManager } from "./config-manager.js";
import { MCPServerManager } from "./mcp-server-manager.js";
import { CodeExecutor } from "./code-executor.js";
import { WorkflowManager } from "./workflow-manager.js";
import { TOONEncoder } from "../toon-encoder.js";
import { PathNormalizer } from "./path-normalizer.js";

export class ToolRegistry {
    private readonly usageSections: Record<string, { title: string; summary: string; steps?: string[]; tips?: string[] }> = {
        overview: {
            title: "Overview",
            summary: "CodeModeTOON is an MCP orchestrator that sits between your AI client and multiple downstream MCP servers. It handles lazy-loading, token-efficient TOON compression, and cross-platform path normalization so agents can iterate quickly without juggling configs."
        },
        quickstart: {
            title: "Quick Start",
            summary: "Minimal flow to get productive once the server is running:",
            steps: [
                "Call list_servers to see which MCPs are already loaded vs available for lazy loading.",
                "Call list_workflows to discover available automation workflows and their required parameters.",
                "Use search_tools {query:\"diag\"} to discover tool names across loaded servers.",
                "Call get_tool_api {serverName:\"workspace-lsp\"} to inspect tool schemas.",
                "Use execute_workflow for standard tasks (e.g., 'research', 'k8s-detective') or execute_code for custom logic."
            ]
        },
        execute_code: {
            title: "execute_code",
            summary: "Runs TypeScript/JavaScript in a vm sandbox with auto-proxied MCP tools.",
            steps: [
                "Inputs: { code: string }.",
                "Sandbox helpers: servers[server].tool(payload), TOON.encode/decode, get_tool_api, search_tools.",
                "Return payload includes captured logs plus the normalized result in TOON.",
                "Guardrails: 100KB code size limit, 60s execution timeout."
            ],
            tips: [
                "Use servers[...] proxies for batching operations.",
                "Check tool return types before assuming arrays.",
                "For complex, reusable logic, consider creating a workflow instead."
            ]
        },
        search_tools: {
            title: "search_tools",
            summary: "Keyword search across tool names/descriptions for servers currently loaded.",
            steps: [
                "Inputs: { query: string, detailLevel?: \"name\" | \"name+description\" | \"full\", hydrateLazy?: boolean }.",
                "Use detailLevel='full' to see complete input schemas.",
                "When hydrateLazy=true, deferred servers are started before searching."
            ],
            tips: [
                "Run search_tools before execute_code to plan which servers to touch."
            ]
        },
        best_practices: {
            title: "Best Practices",
            summary: "Guidance for agent workflows.",
            steps: [
                "Always call list_workflows first to see what high-level capabilities are available.",
                "Use get_tool_api or list_workflows to cache schemas client-side; pair with TOON.encode to trim token usage.",
                "Prefer list_servers over manual assumptions so you know which MCPs are actually online."
            ],
            tips: [
                "All textual outputs normalize Windows paths.",
                "Workflows are preferred over raw execute_code for reliability and reproducibility."
            ]
        },
        troubleshooting: {
            title: "Troubleshooting",
            summary: "Common recovery steps.",
            steps: [
                "If a workflow fails, check the parameters using list_workflows.",
                "If a lazy server fails to hydrate, inspect logs in your MCP client.",
                "Use list_servers to confirm whether a server is lazy, loaded, or disabled."
            ],
            tips: [
                "For stubborn stdio servers, restart CodeModeTOON."
            ]
        }
    };

    constructor(
        private server: Server,
        private configManager: ConfigManager,
        private serverManager: MCPServerManager,
        private codeExecutor: CodeExecutor,
        private workflowManager: WorkflowManager,
        private pathNormalizer: PathNormalizer
    ) { }

    setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const availableServers = Array.from(this.serverManager.getLoadedServers().keys()).join(", ");
            const lazyServers = Array.from(this.serverManager.getLazyServers()).join(", ");
            const workflows = this.workflowManager.listWorkflows();

            return {
                tools: [
                    {
                        name: "execute_code",
                        description: `WHEN TO USE:
- Batching 3+ MCP tool calls (saves round-trips, maintains state)
- Processing large structured data (TOON compression: 30-90% savings)
- Complex logic with conditionals/loops across tool results

DO NOT USE:
- Single simple tool call → use direct MCP
- Unstructured prose → TOON compression <10%

AVAILABLE SERVERS: ${availableServers}
LAZY-LOAD ON DEMAND: ${lazyServers}

WORKFLOWS (use execute_workflow instead for these):
${workflows.map(w => `- ${w.name}: ${w.description}`).join('\n')}

USAGE PATTERN:
\`\`\`typescript
// 1. Discover tools first
const api = await get_tool_api({serverName: 'perplexity'});

// 2. Call tools via proxy
const result = await servers['perplexity'].perplexity_ask({
  messages: [{role: 'user', content: 'Your query'}]
});

// 3. Compress large results
console.log(TOON.encode(result));
\`\`\`

ERROR RECOVERY:
- "Server not found" → list_servers shows available
- "Tool undefined" → get_tool_api({serverName}) shows tools
- "Timeout (60s)" → break into smaller operations

All results TOON-compressed by default.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                code: {
                                    type: "string",
                                    description: "TypeScript/JavaScript code. Use servers['name'].tool({params}) to call MCP tools."
                                }
                            },
                            required: ["code"]
                        }
                    },
                    {
                        name: "execute_workflow",
                        description: "USE WHEN you need research, K8s auditing, or incident analysis. Pre-built automation with parallel execution and automatic retries.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                workflowName: {
                                    type: "string",
                                    description: "Name of workflow to execute",
                                    enum: workflows.map(w => w.name)
                                },
                                parameters: {
                                    type: "object",
                                    description: "Workflow-specific parameters"
                                }
                            },
                            required: ["workflowName"]
                        }
                    },
                    {
                        name: "list_workflows",
                        description: "CALL FIRST to discover available automations before writing custom code. Returns workflow names, descriptions, and required parameters.",
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "search_tools",
                        description: "USE WHEN you don't know which server has the tool you need. Searches across all loaded MCP servers by name/description.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                                detailLevel: { type: "string", enum: ["name", "name+description", "full"], default: "name+description" },
                                hydrateLazy: { type: "boolean", description: "Set true to hydrate lazy servers before searching", default: false },
                                maxLazyServers: { type: "integer", minimum: 1, description: "Optional cap for how many lazy servers to hydrate when searching" }
                            },
                            required: ["query"]
                        }
                    },
                    {
                        name: "get_tool_api",
                        description: "CALL BEFORE using a server to see exact parameter schemas. Returns all tools with their input requirements.",
                        inputSchema: {
                            type: "object",
                            properties: { serverName: { type: "string" } },
                            required: ["serverName"]
                        }
                    },
                    {
                        name: "set_project_root",
                        description: "Set project root for path resolution",
                        inputSchema: {
                            type: "object",
                            properties: { path: { type: "string" } },
                            required: ["path"]
                        }
                    },
                    {
                        name: "list_servers",
                        description: "CALL FIRST to see what MCP servers are available. Shows loaded, lazy (on-demand), and disabled servers.",
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "usage_guide",
                        description: "CALL WHEN confused about CodeModeTOON. Returns step-by-step guides for quickstart, troubleshooting, and best practices.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                section: {
                                    type: "string",
                                    enum: ["overview", "quickstart", "execute_code", "search_tools", "best_practices", "troubleshooting"],
                                    description: "Optional section name to focus on."
                                }
                            }
                        }
                    },
                    {
                        name: "suggest_approach",
                        description: `CALL WHEN UNSURE whether to use execute_code, execute_workflow, or direct MCP.

Analyzes your task and recommends the most efficient approach.
Considers: operation count, data size, existing workflows.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                task: {
                                    type: "string",
                                    description: "What you want to accomplish"
                                },
                                estimated_operations: {
                                    type: "number",
                                    description: "How many tool calls you expect to make"
                                },
                                data_type: {
                                    type: "string",
                                    enum: ["structured_json", "prose_text", "mixed", "unknown"],
                                    description: "Type of data you'll process"
                                }
                            },
                            required: ["task"]
                        }
                    }
                ]
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                if (name === "execute_code") {
                    return await this.codeExecutor.executeCode((args as any).code, this);
                } else if (name === "execute_workflow") {
                    const result = await this.workflowManager.executeWorkflow((args as any).workflowName, (args as any).parameters || {});
                    return { content: [{ type: "text", text: TOONEncoder.encode(result) }] };
                } else if (name === "list_workflows") {
                    const workflows = this.workflowManager.listWorkflows();
                    return { content: [{ type: "text", text: TOONEncoder.encode(workflows) }] };
                } else if (name === "search_tools") {
                    return await this.searchTools(
                        (args as any).query,
                        (args as any).detailLevel,
                        {
                            hydrateLazy: Boolean((args as any).hydrateLazy),
                            maxLazyServers: (args as any).maxLazyServers
                        }
                    );
                } else if (name === "get_tool_api") {
                    return await this.getToolAPI((args as any).serverName);
                } else if (name === "set_project_root") {
                    const newRoot = (args as any).path;
                    this.configManager.setProjectRoot(newRoot);
                    this.pathNormalizer.setProjectRoot(this.configManager.getProjectRoot());
                    return {
                        content: [{ type: "text", text: `Project root set to: ${this.configManager.getProjectRoot()}` }]
                    };
                } else if (name === "list_servers") {
                    return {
                        content: [{
                            type: "text",
                            text: TOONEncoder.encode({
                                loaded: Array.from(this.serverManager.getLoadedServers().keys()),
                                lazyAvailable: Array.from(this.serverManager.getLazyServers()),
                                disabled: this.serverManager.getDisabledServers()
                            })
                        }]
                    };
                } else if (name === "usage_guide") {
                    return this.getUsageGuide((args as any).section);
                } else if (name === "suggest_approach") {
                    return this.suggestApproach(
                        (args as any).task,
                        (args as any).estimated_operations,
                        (args as any).data_type
                    );
                }

                throw new Error(`Unknown tool: ${name}`);
            } catch (error: any) {
                const errorMessage = this.formatError(error, { tool: name, server: (args as any)?.serverName });
                throw new Error(errorMessage);
            }
        });
    }

    async searchTools(
        query: string,
        detailLevel: string = "name+description",
        options?: { hydrateLazy?: boolean; maxLazyServers?: number }
    ) {
        if (options?.hydrateLazy) {
            await this.serverManager.hydrateLazyServers(options.maxLazyServers);
        }

        const results: any[] = [];
        const lowerQuery = query.toLowerCase();

        for (const [serverName, server] of this.serverManager.getLoadedServers()) {
            for (const tool of server.tools) {
                const match =
                    tool.name.toLowerCase().includes(lowerQuery) ||
                    (tool.description || '').toLowerCase().includes(lowerQuery);

                if (match) {
                    if (detailLevel === "name") {
                        results.push({ server: serverName, tool: tool.name });
                    } else if (detailLevel === "name+description") {
                        results.push({
                            server: serverName,
                            tool: tool.name,
                            description: tool.description.substring(0, 150)
                        });
                    } else {
                        results.push({
                            server: serverName,
                            tool: tool.name,
                            description: tool.description,
                            schema: tool.inputSchema
                        });
                    }
                }
            }
        }

        return {
            content: [{ type: "text", text: TOONEncoder.encode(results) }]
        };
    }

    async getToolAPI(serverName: string) {
        try {
            const server = await this.serverManager.ensureServerLoaded(serverName);
            const apiDef = server.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema.properties || {},
                required: tool.inputSchema.required || []
            }));

            return {
                content: [{ type: "text", text: TOONEncoder.encode({ server: serverName, tools: apiDef }) }]
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: "text", text: message }],
                isError: true
            };
        }
    }

    private getUsageGuide(section?: string) {
        const availableSections = Object.keys(this.usageSections);
        const hasSection = Boolean(section && section.trim().length > 0);
        const normalizedSection = hasSection ? section!.trim().toLowerCase() : undefined;

        if (normalizedSection && !this.usageSections[normalizedSection]) {
            return {
                content: [{ type: "text", text: `Unknown usage section "${section}". Available: ${availableSections.join(", ")}` }],
                isError: true
            };
        }

        if (!normalizedSection) {
            const overview = availableSections.map((key) => {
                const entry = this.usageSections[key];
                return `- ${entry.title}: ${entry.summary}`;
            }).join("\n");

            return {
                content: [{
                    type: "text",
                    text: `CodeModeTOON Usage Guide\nCall usage_guide { section: "<name>" } to dive deeper.\n\nSections:\n${overview}`
                }]
            };
        }

        const sectionDef = this.usageSections[normalizedSection];
        const lines: string[] = [`${sectionDef.title}`, sectionDef.summary];

        if (sectionDef.steps?.length) {
            lines.push("", "Steps:", ...sectionDef.steps.map((step, idx) => `${idx + 1}. ${step}`));
        }
        if (sectionDef.tips?.length) {
            lines.push("", "Tips:", ...sectionDef.tips.map((tip) => `- ${tip}`));
        }

        return {
            content: [{ type: "text", text: lines.join("\n") }]
        };
    }

    private suggestApproach(task: string, estimatedOperations: number = 1, dataType: string = "unknown") {
        const workflows = this.workflowManager.listWorkflows();
        const taskLower = task.toLowerCase();

        // Check if a workflow matches
        const matchingWorkflow = workflows.find(w =>
            taskLower.includes(w.name) ||
            w.description.toLowerCase().split(' ').some(word => word.length > 3 && taskLower.includes(word))
        );

        let recommendation: string;

        if (matchingWorkflow) {
            recommendation = `RECOMMENDED: execute_workflow
WORKFLOW: ${matchingWorkflow.name}
REASON: Pre-built workflow exists for this task
USAGE: execute_workflow({workflowName: "${matchingWorkflow.name}", parameters: {...}})
BENEFITS: Parallel execution, automatic retries, optimized for this use case`;
        } else if (estimatedOperations >= 3 || dataType === "structured_json") {
            recommendation = `RECOMMENDED: execute_code
REASON: ${estimatedOperations >= 3 ? `${estimatedOperations} operations benefit from batching` : "Structured data gets 30-90% TOON compression"}
USAGE: Use servers['name'].tool({}) pattern inside execute_code
BENEFITS: State preservation, batched operations, token savings`;
        } else {
            recommendation = `RECOMMENDED: Direct MCP call
REASON: Simple task (${estimatedOperations} operation${estimatedOperations > 1 ? 's' : ''})
USAGE: Call the MCP tool directly without CodeModeTOON overhead`;
        }

        return { content: [{ type: "text", text: recommendation }] };
    }

    private formatError(error: Error, context: { tool?: string, server?: string }): string {
        const base = error.message;
        const hints: string[] = [];

        if (base.includes("not found") && context.server) {
            const loaded = Array.from(this.serverManager.getLoadedServers().keys());
            const lazy = Array.from(this.serverManager.getLazyServers());
            hints.push(`Available servers - Loaded: [${loaded.join(", ")}], Lazy: [${lazy.join(", ")}]`);
            hints.push(`TIP: Call list_servers to see all options`);
        }

        if (base.includes("timeout")) {
            hints.push(`TIP: Break into smaller operations or use a pre-built workflow`);
            hints.push(`Available workflows: ${this.workflowManager.listWorkflows().map(w => w.name).join(", ")}`);
        }

        if (base.includes("undefined") && context.tool) {
            hints.push(`TIP: Call get_tool_api({serverName: "${context.server}"}) to see available tools`);
        }

        return hints.length > 0
            ? `${base}\n\nRECOVERY HINTS:\n${hints.map(h => `• ${h}`).join('\n')}`
            : base;
    }
}
