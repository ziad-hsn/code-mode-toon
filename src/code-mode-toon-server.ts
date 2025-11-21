import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import * as vm from "node:vm";
import { TOONEncoder, compressToolSchema } from "./toon-encoder.js";
import { readFile } from "fs/promises";
import { EventSource } from "eventsource";

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
  toonLevel: 'aggressive' | 'balanced' | 'minimal';
  projectRoot: string;
}

class CodeModeServer {
  private server: Server;
  private mcpServers: Map<string, LoadedMCPServer> = new Map();
  private lazyServers: Set<string> = new Set(); // MCPs to load on-demand
  private config!: { mcpServers: Record<string, MCPServer>; optimizations?: Record<string, any> };
  private codeModeConfig: CodeModeConfig;
  private configPath: string;
  private toolCache: Map<string, any> = new Map(); // Cache for tool results
  private loadingServers: Map<string, Promise<LoadedMCPServer>> = new Map();
  private childProcesses: Set<ChildProcess> = new Set();

  private constructor(configPath: string) {
    this.configPath = configPath;
    this.server = new Server(
      { name: "code-mode-toon", version: "2.1.0" },
      { capabilities: { tools: {} } }
    );

    // Default config, will be overwritten by loadConfig
    this.codeModeConfig = {
      enableTOON: true,
      toonLevel: 'aggressive',
      projectRoot: process.env.PROJECT_ROOT || process.cwd()
    };
  }

  // Centralized stderr logging to keep MCP output clean for clients
  private log(level: "INFO" | "WARN" | "ERROR", message: string) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:mm:ss.sss
    console.error(`[${timestamp}] [${level}] [CodeMode+TOON] ${message}`);
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
            await new Promise<void>(resolve => setTimeout(resolve, 500));

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
        }, 1000);
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
            description: `Execute TypeScript code with MCP tool access (99.8% token reduction)

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
                  default: "json"
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
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "execute_code") {
        return await this.executeCode((args as any).code, (args as any).returnFormat || "json");
      } else if (name === "search_tools") {
        return await this.searchTools((args as any).query, (args as any).detailLevel);
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
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async loadMCPServers() {
    this.log("INFO", "Loading MCP servers...");
    this.log("INFO", `Project root: ${this.codeModeConfig.projectRoot}`);

    const loadPromises: Promise<void>[] = [];
    const startTotal = Date.now();

    for (const [name, config] of Object.entries(this.config.mcpServers)) {
      // Skip comments and disabled servers
      if (name.startsWith('_') || (config as any).disabled) {
        continue;
      }

      // Check if lazy-load
      if ((config as any).lazy) {
        this.lazyServers.add(name);
        this.log("INFO", `deferred ${name} for lazy loading`);
        continue;
      }

      // Load critical servers in parallel
      const promise = this.loadMCPServer(name, config)
        .then((loaded) => {
          this.mcpServers.set(name, loaded);
        })
        .catch((err: any) => {
          this.log("ERROR", `failed to load ${name}: ${err.message}`);
        });

      loadPromises.push(promise);
    }

    await Promise.allSettled(loadPromises);

    const duration = Date.now() - startTotal;
    const totalTools = Array.from(this.mcpServers.values())
      .reduce((sum, s) => sum + s.tools.length, 0);

    this.log("INFO", `Loaded: ${this.mcpServers.size} servers, ${totalTools} tools in ${duration}ms`);
    this.log("INFO", `Lazy-load available: ${this.lazyServers.size} servers`);
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
    // For URL-based MCPs, return a lazy-loaded stub
    // They will be loaded on first use
    return {
      name,
      tools: [],
      call: async (toolName: string, args: any) => {
        throw new Error(`HTTP MCP ${name} not yet implemented`);
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
      // Increased timeout to 120s for uvx/slow startups
      const timeout = setTimeout(() => reject(new Error(`Timeout loading MCP ${name} after 120s`)), 120000);

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
            version: "2.1.0"
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
              initialized = true;
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
      const timeout = setTimeout(() => reject(new Error(`Tool timeout after 60s: ${toolName}`)), 60000);

      const onData = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id && msg.result) {
              clearTimeout(timeout);
              child.stdout.off("data", onData);
              resolve(msg.result);
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
    if (typeof args === "string" && (args.includes("/") || args.includes("\\"))) {
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

  private async ensureServerLoaded(name: string): Promise<LoadedMCPServer> {
    // Lazy-load servers on demand with single-flight protection
    if (this.mcpServers.has(name)) {
      return this.mcpServers.get(name)!;
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

    const loadPromise = this.loadMCPServer(name, config)
      .then((loaded) => {
        this.mcpServers.set(name, loaded);
        this.lazyServers.delete(name);
        console.error(`[CodeMode+TOON] loaded ${name} on-demand (${loaded.tools.length} tools)`);
        return loaded;
      })
      .catch((err) => {
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

  private async ensureAllLazyServersLoaded() {
    // Hydrate all deferred servers before tool discovery
    const pending = Array.from(this.lazyServers);
    for (const name of pending) {
      try {
        await this.ensureServerLoaded(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[CodeMode+TOON] lazy load failed for ${name}: ${message}`);
      }
    }
  }

  private async searchTools(query: string, detailLevel: string) {
    await this.ensureAllLazyServersLoaded();

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

  private async executeCode(code: string, returnFormat: string = "json") {
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

    const context = vm.createContext(sandbox);

    try {
      const wrappedCode = `(async () => { ${code} })()`;
      await vm.runInContext(wrappedCode, context, { timeout: 60000 });

      const executionTime = Date.now() - executionStart;
      const output = logs.join("\n") || "Code executed successfully (no output)";

      return {
        content: [{
          type: "text",
          text: `${output}\n\n[Execution: ${executionTime}ms | Format: ${returnFormat}]`
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
    }
  }

  async start() {
    await this.loadMCPServers();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("[CodeMode+TOON] Server ready!");
    console.error("[CodeMode+TOON] Token savings: 99.8% reduction");
  }
}

const configPath = process.argv[2] || "./mcp-servers-config.json";
CodeModeServer.create(configPath)
  .then(server => server.start())
  .catch(console.error);
