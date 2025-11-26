import { spawn, ChildProcess } from "child_process";
import { TIMEOUTS } from "../constants.js";
import { MCPServer, ConfigManager } from "./config-manager.js";
import { PathNormalizer } from "./path-normalizer.js";

export interface LoadedMCPServer {
    name: string;
    tools: Array<{ name: string; description: string; inputSchema: any }>;
    call: (toolName: string, args: any) => Promise<any>;
}

export class MCPServerManager {
    private static readonly ORCHESTRATOR_VENDOR = "code-mode-toon";
    private static readonly ORCHESTRATOR_SIGNATURE = "code-mode-toon-orchestrator-v1";

    private mcpServers: Map<string, LoadedMCPServer> = new Map();
    private lazyServers: Set<string> = new Set();
    private serverStates: Map<string, 'loading' | 'ready' | 'failed'> = new Map();
    private loadingServers: Map<string, Promise<LoadedMCPServer>> = new Map();
    private childProcesses: Set<ChildProcess> = new Set();
    private failureCounts: Map<string, number> = new Map();

    constructor(
        private configManager: ConfigManager,
        private pathNormalizer: PathNormalizer
    ) { }

    async loadServers(): Promise<void> {
        const config = this.configManager.getMCPServers();
        const eagerLoadPromises: Promise<void>[] = [];
        const startTotal = Date.now();

        console.error(`[CodeMode+TOON] Loading MCP servers...`);

        for (const [name, serverConfig] of Object.entries(config)) {
            if (name.startsWith('_') || serverConfig.disabled) {
                continue;
            }

            if (serverConfig.lazy) {
                this.lazyServers.add(name);
                console.error(`[CodeMode+TOON] Deferred ${name} for lazy loading`);
                continue;
            }

            this.serverStates.set(name, "loading");

            const loadPromise = this.loadMCPServer(name, serverConfig)
                .then((loaded) => {
                    this.mcpServers.set(name, loaded);
                    this.serverStates.set(name, "ready");
                    this.failureCounts.delete(name);
                    console.error(`[CodeMode+TOON] Loaded ${name} (${loaded.tools.length} tools)`);
                })
                .catch((err: any) => {
                    this.serverStates.set(name, "failed");
                    this.failureCounts.set(name, (this.failureCounts.get(name) || 0) + 1);
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[CodeMode+TOON] Failed to load ${name}: ${message}`);
                    throw err;
                });

            eagerLoadPromises.push(loadPromise);
        }

        if (eagerLoadPromises.length > 0) {
            Promise.allSettled(eagerLoadPromises).then((results) => {
                const duration = Date.now() - startTotal;
                const readyCount = Array.from(this.serverStates.values()).filter((state) => state === "ready").length;
                const failedCount = results.filter((r) => r.status === "rejected").length;
                const totalTools = Array.from(this.mcpServers.values()).reduce((sum, s) => sum + s.tools.length, 0);
                console.error(`[CodeMode+TOON] Background load complete after ${duration}ms. Ready: ${readyCount}, Failed: ${failedCount}, Tools: ${totalTools}, Lazy: ${this.lazyServers.size}.`);
            });
        }
    }

    async ensureServerLoaded(name: string): Promise<LoadedMCPServer> {
        if (this.mcpServers.has(name)) {
            return this.mcpServers.get(name)!;
        }

        const currentState = this.serverStates.get(name);
        if (currentState === "loading") {
            const inFlight = this.loadingServers.get(name);
            if (inFlight) return inFlight;
            throw new Error(`Server "${name}" is still loading.`);
        }
        if (currentState === "failed") {
            const failures = this.failureCounts.get(name) || 0;
            if (failures >= 3) {
                throw new Error(`Server "${name}" failed to load earlier (attempts: ${failures}).`);
            }
            // allow retry after failure by clearing state
            this.serverStates.delete(name);
        }

        const config = this.configManager.getMCPServers()[name];
        if (!config || config.disabled) {
            throw new Error(`Server "${name}" not found.`);
        }

        const inFlight = this.loadingServers.get(name);
        if (inFlight) return inFlight;

        this.serverStates.set(name, "loading");

        const loadPromise = this.loadMCPServer(name, config)
            .then((loaded) => {
                this.mcpServers.set(name, loaded);
                this.lazyServers.delete(name);
                this.serverStates.set(name, "ready");
                this.failureCounts.delete(name);
                console.error(`[CodeMode+TOON] loaded ${name} on-demand (${loaded.tools.length} tools)`);
                return loaded;
            })
            .catch((err) => {
                this.serverStates.set(name, "failed");
                this.failureCounts.set(name, (this.failureCounts.get(name) || 0) + 1);
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

    async hydrateLazyServers(limit?: number): Promise<void> {
        const pending = Array.from(this.lazyServers);
        const targets = typeof limit === "number" ? pending.slice(0, limit) : pending;
        if (targets.length === 0) return;

        console.error(`[CodeMode+TOON] Hydrating ${targets.length} lazy server(s): ${targets.join(", ")}`);
        await Promise.allSettled(targets.map((name) => this.ensureServerLoaded(name)));
    }

    getLoadedServers(): Map<string, LoadedMCPServer> {
        return this.mcpServers;
    }

    getLazyServers(): Set<string> {
        return this.lazyServers;
    }

    getDisabledServers(): string[] {
        return Object.entries(this.configManager.getMCPServers())
            .filter(([_, cfg]) => cfg.disabled)
            .map(([name]) => name);
    }

    async shutdown(): Promise<void> {
        console.error("[CodeMode+TOON] Initiating graceful shutdown...");
        const shutdownPromises = Array.from(this.childProcesses).map(async (child) => {
            if (child.killed) return;
            try {
                if (child.stdin && child.stdin.writable) {
                    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "shutdown" }) + "\n");
                    await new Promise<void>(resolve => setTimeout(resolve, TIMEOUTS.SHUTDOWN_GRACE_MS));
                    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "exit" }) + "\n");
                }
            } catch (err) { }
            setTimeout(() => { if (!child.killed) child.kill(); }, TIMEOUTS.FORCE_KILL_MS);
        });
        await Promise.all(shutdownPromises);
        console.error("[CodeMode+TOON] Shutdown complete.");
    }

    private async loadMCPServer(name: string, config: MCPServer): Promise<LoadedMCPServer> {
        if (config.command) {
            return await this.loadStdioMCP(name, config);
        } else if (config.url) {
            return await this.loadHttpMCP(name, config);
        }
        throw new Error(`Invalid config for ${name}: no command or url`);
    }

    private isSelfOrchestrator(serverInfo: any): boolean {
        if (!serverInfo) return false;
        const nameMatch = serverInfo.name === "code-mode-toon";
        const vendorMatch = serverInfo.vendor === MCPServerManager.ORCHESTRATOR_VENDOR;
        const signatureMatch = serverInfo.signature === MCPServerManager.ORCHESTRATOR_SIGNATURE;
        return (vendorMatch && signatureMatch) || (nameMatch && (vendorMatch || signatureMatch)) || nameMatch;
    }

    private async loadHttpMCP(name: string, config: MCPServer): Promise<LoadedMCPServer> {
        if (!config.url) throw new Error(`Invalid config for ${name}: missing url`);

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
            jsonrpc: "2.0", id: initId, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "code-mode-toon", version: "1.0.0" } }
        });

        if (this.isSelfOrchestrator(initResponse?.result?.serverInfo)) {
            throw new Error(`Self-referential server "${name}" detected via MCP handshake`);
        }

        const listResponse: any = await send({ jsonrpc: "2.0", id: initId + 1, method: "tools/list" });
        if (!listResponse?.result?.tools) {
            throw new Error(`HTTP MCP ${name} tools/list failed`);
        }

        return {
            name,
            tools: listResponse.result.tools,
            call: async (toolName: string, args: any) => {
                const result: any = await send({
                    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
                    params: { name: toolName, arguments: this.pathNormalizer.normalizeArguments(args) }
                });
                if (result?.error) throw new Error(`HTTP MCP ${name} tool error: ${result.error.message}`);
                if (!result?.result) throw new Error(`HTTP MCP ${name} tool call missing result`);
                return result.result;
            }
        };
    }

    private async loadStdioMCP(name: string, config: MCPServer): Promise<LoadedMCPServer> {
        const start = Date.now();
        console.error(`[CodeMode+TOON] Starting ${name}...`);

        const child = spawn(config.command!, config.args || [], {
            stdio: ["pipe", "pipe", "inherit"],
            env: { ...process.env, ...config.env },
            cwd: this.configManager.getProjectRoot(),
        });

        this.childProcesses.add(child);
        child.on('exit', () => this.childProcesses.delete(child));

        const send = (msg: any) => {
            if (child.stdin && child.stdin.writable) child.stdin.write(JSON.stringify(msg) + "\n");
        };

        return new Promise((resolve, reject) => {
            let buffer = "";
            let timeout = setTimeout(() => reject(new Error(`Timeout during initialize handshake for ${name}`)), TIMEOUTS.HANDSHAKE_TIMEOUT_MS);
            let initialized = false;
            const initId = 1;

            send({
                jsonrpc: "2.0", id: initId, method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "code-mode-toon", version: "1.0.0" } }
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
                        if (!initialized && msg.id === initId && msg.result) {
                            if (this.isSelfOrchestrator(msg.result.serverInfo)) {
                                clearTimeout(timeout);
                                child.kill();
                                reject(new Error(`Self-referential server "${name}" detected`));
                                return;
                            }
                            initialized = true;
                            clearTimeout(timeout);
                            timeout = setTimeout(() => reject(new Error(`Timeout listing tools for ${name}`)), TIMEOUTS.TOOLS_LIST_TIMEOUT_MS);
                            send({ jsonrpc: "2.0", method: "notifications/initialized" });
                            send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
                        } else if (msg.id === 2 && msg.result?.tools) {
                            clearTimeout(timeout);
                            const duration = Date.now() - start;
                            console.error(`[CodeMode+TOON] Connected to ${name} in ${duration}ms (${msg.result.tools.length} tools)`);
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
        const id = Date.now();
        const request = JSON.stringify({
            jsonrpc: "2.0", id, method: "tools/call",
            params: { name: toolName, arguments: args }
        }) + "\n";

        child.stdin.write(request);

        return new Promise((resolve, reject) => {
            let buffer = "";
            const timeout = setTimeout(() => reject(new Error(`Tool timeout: ${toolName}`)), TIMEOUTS.TOOL_CALL_TIMEOUT_MS);

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
                                reject(new Error(`STDIO MCP tool error (${toolName}): ${msg.error.message}`));
                                return;
                            }
                        }
                    } catch { }
                }
            };
            child.stdout.on("data", onData);
        });
    }
}
