import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import * as vm from "node:vm";
import { TOONEncoder } from "./toon-encoder.js";
import { readFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { TIMEOUTS, LIMITS } from "./constants.js";

interface MCPServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  priority?: string;
  lazy?: boolean;
  disabled?: boolean;
}

interface LoadedMCPServer {
  name: string;
  tools: Array<{ name: string; description: string; inputSchema: any }>;
  call: (toolName: string, args: any) => Promise<any>;
}

interface CodeModeConfig {
  enableTOON: boolean;
  projectRoot: string;
}

class CodeModeServer {
  private static readonly ORCHESTRATOR_VENDOR = "code-mode-toon";
  private static readonly ORCHESTRATOR_SIGNATURE = "code-mode-toon-orchestrator-v1";
  private server: Server;
  private mcpServers: Map<string, LoadedMCPServer> = new Map();
  private lazyServers: Set<string> = new Set(); // MCPs to load on-demand
  private serverStates: Map<string, 'loading' | 'ready' | 'failed'> = new Map();
  private config!: { mcpServers: Record<string, MCPServer>; optimizations?: Record<string, any> };
  private codeModeConfig: CodeModeConfig;
  private configPath: string;
  private loadingServers: Map<string, Promise<LoadedMCPServer>> = new Map();
  private childProcesses: Set<ChildProcess> = new Set();
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

  private constructor(configPath: string) {
    this.configPath = configPath;
    this.server = new Server(
      {
        name: "code-mode-toon",
        version: "1.0.0",
        vendor: CodeModeServer.ORCHESTRATOR_VENDOR,
        signature: CodeModeServer.ORCHESTRATOR_SIGNATURE
      },
      { capabilities: { tools: {} } }
    );

    // Default config, will be overwritten by loadConfig
    this.codeModeConfig = {
      enableTOON: true,
      projectRoot: process.env.PROJECT_ROOT || process.cwd()
    };
  }

  // Centralized stderr logging to keep MCP output clean for clients
  private log(level: "INFO" | "WARN" | "ERROR", message: string) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:mm:ss.sss
    console.error(`[${timestamp}] [${level}] [CodeMode+TOON] ${message}`);
  }

  private isSelfOrchestrator(serverInfo: any): boolean {
    if (!serverInfo) {
      return false;
    }

    const nameMatch = serverInfo.name === "code-mode-toon";
    const vendorMatch = serverInfo.vendor === CodeModeServer.ORCHESTRATOR_VENDOR;
    const signatureMatch = serverInfo.signature === CodeModeServer.ORCHESTRATOR_SIGNATURE;

    // Prefer explicit vendor + signature match for new versions
    if (vendorMatch && signatureMatch) {
      return true;
    }

    // Fallback to name match when older versions do not expose vendor/signature
    if (nameMatch && (vendorMatch || signatureMatch)) {
      return true;
    }

    // As a final safeguard, treat name-only matches as self-reference
    return nameMatch;
  }

  static async create(configPath: string): Promise<CodeModeServer> {
    const instance = new CodeModeServer(configPath);
    await instance.loadConfig();
    instance.setupHandlers();
    instance.setupProcessHandlers();
    return instance;
  }

  private async loadConfig() {
    try {
      const configData = await readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(configData);

      // Extract optimizations
      if (this.config.optimizations) {
        this.codeModeConfig.projectRoot =
          this.config.optimizations.projectRoot ||
          process.env.PROJECT_ROOT ||
          this.codeModeConfig.projectRoot;
      }
    } catch (error) {
      this.log("ERROR", `Failed to load config from ${this.configPath}, using defaults. Error: ${error}`);
      this.config = { mcpServers: {} };
    }
  }

  private setupProcessHandlers() {
    // Gracefully drain child MCPs on process termination before forced kill
    const cleanup = async () => {
      this.log("INFO", "Initiating graceful shutdown...");

      const shutdownPromises = Array.from(this.childProcesses).map(async (child) => {
        if (child.killed) return;

        try {
          // 1. Send shutdown request
          if (child.stdin && child.stdin.writable) {
            const shutdownId = Date.now();
            child.stdin.write(JSON.stringify({
              jsonrpc: "2.0",
              id: shutdownId,
              method: "shutdown"
            }) + "\n");

            // Wait briefly for shutdown response (optional, but good practice)
            await new Promise<void>(resolve => setTimeout(resolve, TIMEOUTS.SHUTDOWN_GRACE_MS));

            // 2. Send exit notification
            child.stdin.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "exit"
            }) + "\n");
          }
        } catch (err) {
          // Ignore errors during shutdown
        }

        // 3. Force kill if still running after a short delay
        setTimeout(() => {
          if (!child.killed) child.kill();
        }, TIMEOUTS.FORCE_KILL_MS);
      });

      await Promise.all(shutdownPromises);
      this.log("INFO", "Shutdown complete.");
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const availableServers = Array.from(this.mcpServers.keys()).join(", ");
      const lazyServers = Array.from(this.lazyServers).join(", ");

      return {
        tools: [
          {
            name: "execute_code",
            description: `Execute TypeScript code with MCP tool access (TOON-compressed responses)

AVAILABLE SERVERS:
Loaded: ${availableServers}
${lazyServers ? `Lazy-load on demand: ${lazyServers}` : ''}

CRITICAL PATTERNS:
1. Discover tools first:
   const api = await get_tool_api({serverName: 'go-development'});
   console.log(api);

2. Call discovered methods:
   const result = await servers['go-development'].check_diagnostics({...});
   console.log(result); // Auto-unwrapped

3. Batch operations in code:
   for (const file of files) {
     const diag = await servers['workspace-lsp'].diagnostics({filePath: file});
     // Process in sandbox, not your context
   }

4. Use TOON for large data:
   console.log(TOON.encode(result)); // 40% smaller

RETURN VALUE GOTCHAS:
- check_diagnostics returns string "[]" when clean (not array!)
- diagnostics returns string "No diagnostics found..." when clean
- Use typeof result === 'string' before .split()`,
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string" },
                returnFormat: {
                  type: "string",
                  enum: ["json", "toon"],
                  default: "toon"
                }
              },
              required: ["code"]
            }
          },
          {
            name: "search_tools",
            description: "Search available MCP tools by keyword (progressive disclosure)",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                detailLevel: {
                  type: "string",
                  enum: ["name", "name+description", "full"],
                  default: "name+description"
                },
                hydrateLazy: {
                  type: "boolean",
                  description: "Set true to hydrate lazy servers before searching",
                  default: false
                },
                maxLazyServers: {
                  type: "integer",
                  minimum: 1,
                  description: "Optional cap for how many lazy servers to hydrate when searching"
                }
              },
              required: ["query"]
            }
          },
          {
            name: "get_tool_api",
            description: "Get complete tool list and signatures for a server",
            inputSchema: {
              type: "object",
              properties: {
                serverName: { type: "string" }
              },
              required: ["serverName"]
            }
          },
          {
            name: "set_project_root",
            description: "Set project root for path resolution",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"]
            }
          },
          {
            name: "list_servers",
            description: "List all loaded and lazy-load MCP servers",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "usage_guide",
            description: "Retrieve inline documentation for CodeModeTOON (sections: overview, quickstart, execute_code, search_tools, best_practices, troubleshooting)",
            inputSchema: {
              type: "object",
              properties: {
                section: {
                  type: "string",
                  enum: ["overview", "quickstart", "execute_code", "search_tools", "best_practices", "troubleshooting"],
                  description: "Optional section name to focus on. If omitted, returns the table of contents."
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
        return await this.executeCode((args as any).code, (args as any).returnFormat || "toon");
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
        this.codeModeConfig.projectRoot = (args as any).path;
        return {
          content: [{
            type: "text",
            text: `Project root set to: ${this.codeModeConfig.projectRoot}`
          }]
        };
      } else if (name === "list_servers") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              loaded: Array.from(this.mcpServers.keys()),
              lazyAvailable: Array.from(this.lazyServers),
              disabled: Object.entries(this.config.mcpServers)
                .filter(([_, cfg]) => (cfg as any).disabled)
                .map(([name]) => name)
            }, null, 2)
          }]
        };
      } else if (name === "usage_guide") {
        return this.getUsageGuide((args as any).section);
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async loadMCPServers() {
    this.log("INFO", "Loading MCP servers...");
    this.log("INFO", `Project root: ${this.codeModeConfig.projectRoot}`);

    const eagerLoadPromises: Promise<void>[] = [];
    const startTotal = Date.now();

    for (const [name, config] of Object.entries(this.config.mcpServers)) {
      // Skip comments and disabled servers
      if (name.startsWith('_') || (config as any).disabled) {
        continue;
      }

      // Lazy-load servers are deferred until first use
      if ((config as any).lazy) {
        this.lazyServers.add(name);
        this.log("INFO", `Deferred ${name} for lazy loading`);
        continue;
      }

      this.serverStates.set(name, "loading");

      const loadPromise = this.loadMCPServer(name, config)
        .then((loaded) => {
          this.mcpServers.set(name, loaded);
          this.serverStates.set(name, "ready");
          this.log("INFO", `Loaded ${name} (${loaded.tools.length} tools)`);
        })
        .catch((err: any) => {
          this.serverStates.set(name, "failed");
          const message = err instanceof Error ? err.message : String(err);
          this.log("ERROR", `Failed to load ${name}: ${message}`);
          throw err;
        });

      eagerLoadPromises.push(loadPromise);
    }

    if (eagerLoadPromises.length === 0) {
      this.log("INFO", "No eager-load MCP servers configured; awaiting lazy/on-demand loads.");
      return;
    }

    let firstReadyLogged = false;
    try {
      await Promise.any(eagerLoadPromises);
      firstReadyLogged = true;
      this.log("INFO", "First MCP server ready, enabling tools immediately.");
    } catch {
      this.log("WARN", "All eager MCP servers failed to load. Tools will rely on lazy/on-demand servers.");
    }

    if (!firstReadyLogged) {
      // Even if all failed, continue to monitor completions for logging.
      this.log("WARN", "Continuing startup while MCP servers resolve in background.");
    }

    Promise.allSettled(eagerLoadPromises).then((results) => {
      const duration = Date.now() - startTotal;
      const readyCount = Array.from(this.serverStates.values()).filter((state) => state === "ready").length;
      const failedCount = results.filter((r) => r.status === "rejected").length;
      const totalTools = Array.from(this.mcpServers.values()).reduce((sum, s) => sum + s.tools.length, 0);
      this.log("INFO", `Background load complete after ${duration}ms. Ready: ${readyCount}, Failed: ${failedCount}, Tools: ${totalTools}, Lazy: ${this.lazyServers.size}.`);
    }).catch((err) => {
      // This should never happen with allSettled, but add for safety
      this.log("ERROR", `Unexpected error in background load: ${err}`);
    });
  }

  private async loadMCPServer(name: string, config: MCPServer): Promise<LoadedMCPServer> {
    if (config.command) {
      return await this.loadStdioMCP(name, config);
    } else if (config.url) {
      return await this.loadHttpMCP(name, config);
    }
    throw new Error(`Invalid config for ${name}: no command or url`);
  }

  private async loadHttpMCP(name: string, config: MCPServer): Promise<LoadedMCPServer> {
    if (!config.url) {
      throw new Error(`Invalid config for ${name}: missing url`);
    }

    const send = async (payload: any, timeoutMs = 30000): Promise<any> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(config.url!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP MCP ${name} request failed (${response.status}): ${body}`);
        }

        return await response.json() as any;
      } finally {
        clearTimeout(timeout);
      }
    };

    const initId = Date.now();
    const initResponse: any = await send({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "code-mode-toon",
          version: "1.0.0"
        }
      }
    });

    if (this.isSelfOrchestrator(initResponse?.result?.serverInfo)) {
      this.log("WARN", `Skipping self-referential server "${name}" detected via MCP handshake.`);
      throw new Error(`Self-referential server "${name}" detected via MCP handshake`);
    }

    if (!initResponse?.result) {
      throw new Error(`HTTP MCP ${name} initialize failed: ${JSON.stringify(initResponse)}`);
    }

    const listId = initId + 1;
    const listResponse: any = await send({
      jsonrpc: "2.0",
      id: listId,
      method: "tools/list"
    });

    if (!listResponse?.result?.tools) {
      throw new Error(`HTTP MCP ${name} tools/list failed: ${JSON.stringify(listResponse)}`);
    }

    this.log("INFO", `Connected to HTTP MCP ${name} (${listResponse.result.tools.length} tools)`);

    return {
      name,
      tools: listResponse.result.tools,
      call: async (toolName: string, args: any) => {
        const id = Date.now();
        const normalizedArgs = this.normalizeArguments(args);
        const result: any = await send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: toolName, arguments: normalizedArgs }
        });

        if (result?.error) {
          throw new Error(`HTTP MCP ${name} tool error: ${result.error.message || JSON.stringify(result.error)}`);
        }

        if (!result?.result) {
          throw new Error(`HTTP MCP ${name} tool call missing result: ${JSON.stringify(result)}`);
        }

        return result.result;
      }
    };
  }

  private async loadStdioMCP(name: string, config: MCPServer): Promise<LoadedMCPServer> {
    // Spawn a stdio MCP server and perform the initialize -> tools/list handshake
    const start = Date.now();
    this.log("INFO", `Starting ${name}...`);

    const child = spawn(config.command!, config.args || [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...config.env },
      cwd: this.codeModeConfig.projectRoot,
    });

    this.childProcesses.add(child);
    child.on('exit', () => this.childProcesses.delete(child));

    // Helper to send JSON-RPC message
    const send = (msg: any) => {
      if (child.stdin && child.stdin.writable) {
        child.stdin.write(JSON.stringify(msg) + "\n");
      }
    };

    return new Promise((resolve, reject) => {
      let buffer = "";

      // Split timeouts: short for initial handshake, longer for tools list
      let timeout = setTimeout(() => reject(new Error(`Timeout during initialize handshake for ${name} after ${TIMEOUTS.HANDSHAKE_TIMEOUT_MS}ms`)), TIMEOUTS.HANDSHAKE_TIMEOUT_MS);

      let initialized = false;
      const initId = 1;

      // 1. Send Initialize Request
      send({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "code-mode-toon",
            version: "1.0.0"
          }
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${name}: ${err.message}`));
      });

      child.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            // 2. Handle Initialize Response
            if (!initialized && msg.id === initId && msg.result) {
              if (this.isSelfOrchestrator(msg.result.serverInfo)) {
                clearTimeout(timeout);
                this.log("WARN", `Skipping self-referential server "${name}" detected via MCP handshake.`);
                child.kill();
                reject(new Error(`Self-referential server "${name}" detected via MCP handshake`));
                return;
              }
              initialized = true;

              // Extend timeout for tools/list which can be slower (up to 120s)
              clearTimeout(timeout);
              timeout = setTimeout(() => reject(new Error(`Timeout listing tools for ${name} after ${TIMEOUTS.TOOLS_LIST_TIMEOUT_MS}ms`)), TIMEOUTS.TOOLS_LIST_TIMEOUT_MS);

              // 3. Send Initialized Notification
              send({
                jsonrpc: "2.0",
                method: "notifications/initialized"
              });

              // 4. Now request tools
              send({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list"
              });
            }
            // 5. Handle Tools List Response
            else if (msg.id === 2 && msg.result?.tools) {
              clearTimeout(timeout);
              const duration = Date.now() - start;
              this.log("INFO", `Connected to ${name} in ${duration}ms (${msg.result.tools.length} tools)`);
              resolve({
                name,
                tools: msg.result.tools,
                call: async (toolName: string, args: any) => {
                  return await this.callStdioMCP(child, toolName, args);
                }
              });
            }
          } catch { }
        }
      });
    });
  }

  private async callStdioMCP(child: any, toolName: string, args: any): Promise<any> {
    // Send tools/call request and await the matching JSON-RPC response with timeout
    const id = Date.now();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    }) + "\n";

    child.stdin.write(request);

    return new Promise((resolve, reject) => {
      let buffer = "";
      // Increase timeout for slow operations like go_to_definition
      const timeout = setTimeout(() => reject(new Error(`Tool timeout after ${TIMEOUTS.TOOL_CALL_TIMEOUT_MS}ms: ${toolName}`)), TIMEOUTS.TOOL_CALL_TIMEOUT_MS);

      const onData = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) {
              if (msg.result) {
                clearTimeout(timeout);
                child.stdout.off("data", onData);
                resolve(msg.result);
                return;
              }
              if (msg.error) {
                clearTimeout(timeout);
                child.stdout.off("data", onData);
                const errorMessage = msg.error.message || JSON.stringify(msg.error);
                reject(new Error(`STDIO MCP tool error (${toolName}): ${errorMessage}`));
                return;
              }
            }
          } catch { }
        }
      };

      child.stdout.on("data", onData);
    });
  }

  private normalizeArguments(args: any): any {
    if (args === undefined || args === null) {
      return args;
    }
    if (typeof args === "string" && this.shouldNormalizePath(args)) {
      return this.normalizePath(args);
    }
    if (Array.isArray(args)) {
      return args.map((value) => this.normalizeArguments(value));
    }
    if (typeof args === "object") {
      const normalized: Record<string, any> = {};
      for (const [key, value] of Object.entries(args)) {
        normalized[key] = this.normalizeArguments(value);
      }
      return normalized;
    }
    return args;
  }

  private shouldNormalizePath(value: string): boolean {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
    const trimmed = value.trim();
    return (
      trimmed.startsWith('/') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      trimmed.startsWith('file://') ||
      trimmed.startsWith('~') ||
      trimmed.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(trimmed)
    );
  }

  private normalizePath(path: string): string {
    // Normalize common path quirks for MCP tools (Windows drive prefix, file://, rel->abs)
    if (path.startsWith('/C:') || path.startsWith('/c:')) {
      path = path.substring(1);
    }
    // Handle file:// URIs
    if (path.startsWith('file:///')) {
      path = path.substring(8);
    }
    // Convert relative paths to absolute
    if (!path.includes(':') && !path.startsWith('/')) {
      path = `${this.codeModeConfig.projectRoot}/${path}`;
    }

    // On Windows, convert forward slashes to backslashes for absolute paths
    // This fixes mcp-language-server file reading issues
    if (process.platform === 'win32' && path.match(/^[A-Za-z]:/)) {
      path = path.replace(/\//g, '\\');
    }

    return path;
  }

  private normalizePathsInResult(result: any): any {
    if (typeof result === 'string') {
      // Fix Windows paths in text results: /C:/ -> C:/
      let normalized = result.replace(/\/([A-Za-z]):\//g, '$1:/');

      // On Windows, convert forward slashes to backslashes in absolute paths
      if (process.platform === 'win32') {
        normalized = normalized.replace(/([A-Za-z]:)\/([^\s\n]*)/g, (match, drive, rest) => {
          return drive + '\\' + rest.replace(/\//g, '\\');
        });
      }

      return normalized;
    }
    if (Array.isArray(result)) {
      return result.map(item => this.normalizePathsInResult(item));
    }
    if (result && typeof result === 'object') {
      const normalized: any = {};
      for (const [key, value] of Object.entries(result)) {
        if (key === 'uri' && typeof value === 'string') {
          normalized[key] = this.normalizePath(value);
        } else {
          normalized[key] = this.normalizePathsInResult(value);
        }
      }
      return normalized;
    }
    return result;
  }

  private unwrapMCPResult(result: any): any {
    // Unwrap MCP envelopes and TOON payloads before returning to caller
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

    // Fix Windows paths in the unwrapped result
    return this.normalizePathsInResult(unwrapped);
  }

  private getUsageGuide(section?: string) {
    const availableSections = Object.keys(this.usageSections);
    const hasSection = Boolean(section && section.trim().length > 0);
    const normalizedSection = hasSection ? section!.trim().toLowerCase() : undefined;

    if (normalizedSection && !this.usageSections[normalizedSection]) {
      return {
        content: [{
          type: "text",
          text: `Unknown usage section "${section}". Available: ${availableSections.join(", ")}`
        }],
        isError: true
      };
    }

    if (!normalizedSection) {
      const overview = availableSections.map((key) => {
        const entry = this.usageSections[key];
        return `- ${entry.title}: ${entry.summary}`;
      }).join("\n");

      const body = [
        "CodeModeTOON Usage Guide",
        "Call usage_guide { section: \"<name>\" } to dive deeper into a specific topic.",
        `Sections:\n${overview}`
      ].join("\n\n");

      return {
        content: [{
          type: "text",
          text: body
        }]
      };
    }

    const sectionDef = this.usageSections[normalizedSection];
    const lines: string[] = [
      `${sectionDef.title}`,
      sectionDef.summary
    ];

    if (sectionDef.steps?.length) {
      lines.push(
        "",
        "Steps:",
        ...sectionDef.steps.map((step, idx) => `${idx + 1}. ${step}`)
      );
    }

    if (sectionDef.tips?.length) {
      lines.push(
        "",
        "Tips:",
        ...sectionDef.tips.map((tip) => `- ${tip}`)
      );
    }

    return {
      content: [{
        type: "text",
        text: lines.join("\n")
      }]
    };
  }

  private async ensureServerLoaded(name: string): Promise<LoadedMCPServer> {
    // Lazy-load servers on demand with single-flight protection
    if (this.mcpServers.has(name)) {
      return this.mcpServers.get(name)!;
    }

    const currentState = this.serverStates.get(name);
    if (currentState === "loading") {
      // Wait for in-flight load instead of throwing error
      const inFlight = this.loadingServers.get(name);
      if (inFlight) {
        this.log("INFO", `Server "${name}" is already loading, waiting for completion...`);
        return inFlight;
      }
      throw new Error(`Server "${name}" is still loading. Use get_server_status for details and try again shortly.`);
    }
    if (currentState === "failed") {
      throw new Error(`Server "${name}" failed to load earlier. Check logs or restart CodeModeTOON.`);
    }

    const config = this.config.mcpServers[name];
    if (!config || (config as any).disabled) {
      throw new Error(`Server "${name}" not found. Available: ${Array.from(new Set([
        ...this.mcpServers.keys(),
        ...this.lazyServers
      ])).join(", ")}`);
    }

    const inFlight = this.loadingServers.get(name);
    if (inFlight) {
      return inFlight;
    }

    this.serverStates.set(name, "loading");

    const loadPromise = this.loadMCPServer(name, config)
      .then((loaded) => {
        this.mcpServers.set(name, loaded);
        this.lazyServers.delete(name);
        this.serverStates.set(name, "ready");
        console.error(`[CodeMode+TOON] loaded ${name} on-demand (${loaded.tools.length} tools)`);
        return loaded;
      })
      .catch((err) => {
        this.serverStates.set(name, "failed");
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[CodeMode+TOON] failed to load ${name} on-demand: ${message}`);
        throw err;
      })
      .finally(() => {
        this.loadingServers.delete(name);
      });

    this.loadingServers.set(name, loadPromise);
    return loadPromise;
  }

  private async hydrateLazyServers(limit?: number) {
    const pending = Array.from(this.lazyServers);
    const targets = typeof limit === "number" ? pending.slice(0, limit) : pending;
    if (targets.length === 0) {
      return;
    }

    this.log("INFO", `Hydrating ${targets.length} lazy server(s): ${targets.join(", ")}`);
    await Promise.allSettled(targets.map((name) => this.ensureServerLoaded(name)));
  }

  private async searchTools(
    query: string,
    detailLevel: string = "name+description",
    options?: { hydrateLazy?: boolean; maxLazyServers?: number }
  ) {
    if (options?.hydrateLazy) {
      await this.hydrateLazyServers(options.maxLazyServers);
    }

    const results: any[] = [];
    const lowerQuery = query.toLowerCase();

    for (const [serverName, server] of this.mcpServers) {
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
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2)
      }]
    };
  }

  private async getToolAPI(serverName: string) {
    try {
      const server = await this.ensureServerLoaded(serverName);
      const apiDef = server.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema.properties || {},
        required: tool.inputSchema.required || []
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ server: serverName, tools: apiDef }, null, 2)
        }]
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: "text",
          text: message
        }],
        isError: true
      };
    }
  }

  private async executeCode(code: string, returnFormat: string = "toon") {
    // Input validation
    if (!code || typeof code !== 'string') {
      return {
        content: [{
          type: "text",
          text: "Error: 'code' parameter must be a non-empty string"
        }],
        isError: true
      };
    }

    if (code.length > LIMITS.CODE_SIZE_BYTES) {
      return {
        content: [{
          type: "text",
          text: `Error: Code exceeds maximum length of ${LIMITS.CODE_SIZE_BYTES} bytes (received ${code.length} bytes)`
        }],
        isError: true
      };
    }

    if (returnFormat && !['json', 'toon'].includes(returnFormat)) {
      return {
        content: [{
          type: "text",
          text: `Error: Invalid returnFormat '${returnFormat}'. Must be 'json' or 'toon'`
        }],
        isError: true
      };
    }

    const logs: string[] = [];
    const executionStart = Date.now();

    const serverNames = new Set<string>([
      ...Object.keys(this.config.mcpServers || {}),
      ...this.mcpServers.keys(),
      ...this.lazyServers
    ]);

    // Build per-server proxies so sandboxed code can call tools directly while resolving lazy servers on demand
    const serversAPI: Record<string, any> = {};
    for (const name of serverNames) {
      serversAPI[name] = new Proxy({}, {
        get: (_target, prop) => {
          if (prop === "then") {
            return undefined;
          }
          if (typeof prop !== "string") {
            return undefined;
          }
          return async (rawArgs: any) => {
            const server = await this.ensureServerLoaded(name);
            const tool = server.tools.find((t) => t.name === prop);
            if (!tool) {
              throw new Error(`Tool "${prop}" not found on server "${name}"`);
            }
            const args = this.normalizeArguments(rawArgs);
            const result = await server.call(tool.name, args);
            return this.unwrapMCPResult(result);
          };
        }
      });
    }

    const sandbox = {
      servers: serversAPI,
      console: {
        log: (...args: any[]) => {
          const output = args.map(a => {
            if (typeof a === 'object') return JSON.stringify(a, null, 2);
            return String(a);
          }).join(" ");
          logs.push(output);
        },
        error: (...args: any[]) => logs.push("[ERROR] " + args.join(" ")),
        warn: (...args: any[]) => logs.push("[WARN] " + args.join(" "))
      },
      TOON: {
        encode: (data: any) => TOONEncoder.encode(data),
        decode: (toon: string) => TOONEncoder.decode(toon)
      },
      get_tool_api: async (params: any) => {
        const result = await this.getToolAPI(params.serverName);
        return this.unwrapMCPResult(result);
      },
      search_tools: async (params: any) => {
        const result = await this.searchTools(params.query, params.detailLevel || "name+description");
        return this.unwrapMCPResult(result);
      }
    };

    // Track timers for cleanup
    const timers: NodeJS.Timeout[] = [];
    const intervals: NodeJS.Timeout[] = [];

    // Wrap setTimeout/setInterval to track them
    (sandbox as any).setTimeout = (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      const id = setTimeout(callback, ms, ...args);
      timers.push(id);
      return id;
    };
    (sandbox as any).setInterval = (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      const id = setInterval(callback, ms, ...args);
      intervals.push(id);
      return id;
    };
    (sandbox as any).clearTimeout = (id: NodeJS.Timeout) => {
      const index = timers.indexOf(id);
      if (index > -1) timers.splice(index, 1);
      clearTimeout(id);
    };
    (sandbox as any).clearInterval = (id: NodeJS.Timeout) => {
      const index = intervals.indexOf(id);
      if (index > -1) intervals.splice(index, 1);
      clearInterval(id);
    };

    const context = vm.createContext(sandbox, {
      codeGeneration: {
        strings: false,  // Prevent eval(), new Function()
        wasm: false      // Prevent WebAssembly
      }
    });

    try {
      const wrappedCode = `(async () => { ${code} })()`;
      const result = await vm.runInContext(wrappedCode, context, { timeout: TIMEOUTS.CODE_EXECUTION_TIMEOUT_MS });

      const executionTime = Date.now() - executionStart;
      const normalizedFormat = returnFormat === "toon" ? "toon" : "json";
      const normalizedResult = this.normalizePathsInResult(result);
      const safeResult = normalizedResult === undefined ? null : normalizedResult;
      const formattedResult =
        normalizedFormat === "toon"
          ? TOONEncoder.encode(safeResult)
          : JSON.stringify(safeResult, null, 2);

      const sections: string[] = [];
      if (logs.length) {
        sections.push(`Logs:\n${logs.join("\n")}`);
      }
      sections.push(`Result (${normalizedFormat.toUpperCase()}):\n${formattedResult}`);
      sections.push(`[Execution: ${executionTime}ms]`);

      return {
        content: [{
          type: "text",
          text: sections.join("\n\n")
        }]
      };
    } catch (err: any) {
      return {
        content: [{
          type: "text",
          text: `Execution error: ${err.message}\n\nLogs:\n${logs.join("\n")}`
        }],
        isError: true
      };
    } finally {
      // Cleanup timers to prevent memory leaks
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
    }
  }

  async start() {
    const transport = new StdioServerTransport();

    // Prevent infinite loops: Wait for client handshake BEFORE loading downstream servers.
    // If we are a nested instance, the parent will detect our vendor/signature in the
    // initialize response and kill us before we receive the 'initialized' notification.
    this.server.oninitialized = async () => {
      this.log("INFO", "Client initialized. Loading downstream servers...");
      await this.loadMCPServers();

      const loadingCount = Array.from(this.serverStates.values()).filter((state) => state === 'loading').length;
      this.log('INFO', `Startup availability: ready=${this.mcpServers.size}, loading=${loadingCount}, lazy=${this.lazyServers.size}`);
      console.error("[CodeMode+TOON] Server ready!");
    };

    await this.server.connect(transport);
    this.log("INFO", "MCP transport connected. Waiting for client initialization...");
  }
}

const defaultConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');

function expandPath(input: string): string {
  if (!input) {
    return input;
  }
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

const rawConfigPath =
  process.argv[2] ||
  process.env.CODE_MODE_TOON_CONFIG ||
  defaultConfigPath;

const resolvedConfigPath = path.resolve(expandPath(rawConfigPath));
console.error(`[CodeMode+TOON] Using config: ${resolvedConfigPath}`);

CodeModeServer.create(resolvedConfigPath)
  .then(server => server.start())
  .catch(console.error);
