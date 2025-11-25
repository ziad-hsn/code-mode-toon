import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ConfigManager } from "./config-manager.js";
import { MCPServerManager } from "./mcp-server-manager.js";
import { CodeExecutor } from "./code-executor.js";
import { WorkflowManager } from "./workflow-manager.js";
import { TOONEncoder } from "../toon-encoder.js";

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
                "Use search_tools {query:\"diag\"} to discover tool names across loaded servers. Set hydrateLazy=true if you need all servers online first.",
                "Call get_tool_api {serverName:\"workspace-lsp\"} (or any server) to inspect tool schemas and parameters.",
                "When calling execute_code, start with set_project_root to align relative paths, then invoke servers[\"name\"].tool(...) inside the sandbox."
            ]
        },
        execute_code: {
            title: "execute_code",
            summary: "Runs TypeScript/JavaScript in a vm sandbox with auto-proxied MCP tools.",
            steps: [
                "Inputs: { code: string, returnFormat?: \"json\" | \"toon\" }.",
                "Sandbox helpers: servers[server].tool(payload), TOON.encode/decode, get_tool_api, search_tools, and console logging.",
                "Return payload includes captured logs plus the normalized result in JSON or TOON.",
                "Guardrails: 100KB code size limit, 60s execution timeout, automatic path normalization for tool arguments."
            ],
            tips: [
                "Use servers[...] proxies for batching (e.g., loop through files and call diagnostics).",
                "Check tool return types before assuming arrays—some MCPs respond with strings such as \"[]\" or \"No diagnostics found\"."
            ]
        },
        search_tools: {
            title: "search_tools",
            summary: "Keyword search across tool names/descriptions for servers currently loaded.",
            steps: [
                "Inputs: { query: string, detailLevel?: \"name\" | \"name+description\" | \"full\", hydrateLazy?: boolean, maxLazyServers?: number }.",
                "When hydrateLazy=true the orchestrator will spin up deferred servers up to maxLazyServers before searching.",
                "detailLevel controls verbosity so UIs can show lightweight or full schema output."
            ],
            tips: [
                "Run search_tools before execute_code to plan which servers to touch.",
                "Use hydrateLazy sparingly; it forces downstream process launches."
            ]
        },
        best_practices: {
            title: "Best Practices",
            summary: "Guidance for agent workflows.",
            steps: [
                "Call set_project_root whenever the working tree changes (especially in multi-workspace agents).",
                "Use get_tool_api to cache tool schemas client-side; pair with TOON.encode to trim token usage for large schemas.",
                "Prefer list_servers over manual assumptions so you know which MCPs are actually online."
            ],
            tips: [
                "All textual outputs normalize Windows paths; if you rely on original casing include the raw server response in logs.",
                "When bridging remote MCPs over HTTP, keep env vars in the config file ignored by Git (`mcp-servers-config*.json`)."
            ]
        },
        troubleshooting: {
            title: "Troubleshooting",
            summary: "Common recovery steps.",
            steps: [
                "If a lazy server fails to hydrate, inspect logs in your MCP client—they include the downstream error message.",
                "Use list_servers to confirm whether a server is lazy, loaded, or disabled.",
                "execute_code returns combined logs + error text; include both when filing issues."
            ],
            tips: [
                "For stubborn stdio servers, restart CodeModeTOON so the graceful shutdown handler can drain lingering child processes."
            ]
        }
    };

    constructor(
        private server: Server,
        private configManager: ConfigManager,
        private serverManager: MCPServerManager,
        private codeExecutor: CodeExecutor,
        private workflowManager: WorkflowManager
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
                        description: `Execute TypeScript code with MCP tool access (TOON-compressed responses)
AVAILABLE SERVERS:
Loaded: ${availableServers}
${lazyServers ? `Lazy-load on demand: ${lazyServers}` : ''}
AVAILABLE WORKFLOWS:
${workflows.map(w => `- ${w.name}: ${w.description}`).join('\n')}

CRITICAL PATTERNS:
1. Discover tools first: const api = await get_tool_api({serverName: 'go-development'});
2. Call discovered methods: const result = await servers['go-development'].check_diagnostics({...});
3. Batch operations in code: for (const file of files) { ... }
4. Use TOON for large data: console.log(TOON.encode(result));

NOTE: All results are TOON-compressed to maximize efficiency.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                code: { type: "string" }
                            },
                            required: ["code"]
                        }
                    },
                    {
                        name: "execute_workflow",
                        description: "Execute a predefined workflow",
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
                        description: "List all available workflows",
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "search_tools",
                        description: "Search available MCP tools by keyword (progressive disclosure)",
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
                        description: "Get complete tool list and signatures for a server",
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
                        description: "List all loaded and lazy-load MCP servers",
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "usage_guide",
                        description: "Retrieve inline documentation for CodeModeTOON",
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
                    }
                ]
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

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
                this.configManager.setProjectRoot((args as any).path);
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
            }

            throw new Error(`Unknown tool: ${name}`);
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
                    tool.description.toLowerCase().includes(lowerQuery);

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
}
