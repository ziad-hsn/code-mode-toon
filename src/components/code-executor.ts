import * as vm from "node:vm";
import { TOONEncoder } from "../toon-encoder.js";
import { TIMEOUTS, LIMITS } from "../constants.js";
import { MCPServerManager } from "./mcp-server-manager.js";
import { PathNormalizer } from "./path-normalizer.js";

export class CodeExecutor {
    constructor(
        private serverManager: MCPServerManager,
        private pathNormalizer: PathNormalizer
    ) { }

    async executeCode(code: string, toolRegistry: any): Promise<any> {
        // Input validation
        if (!code || typeof code !== 'string') {
            return {
                content: [{ type: "text", text: "Error: 'code' parameter must be a non-empty string" }],
                isError: true
            };
        }

        if (code.length > LIMITS.CODE_SIZE_BYTES) {
            return {
                content: [{ type: "text", text: `Error: Code exceeds maximum length of ${LIMITS.CODE_SIZE_BYTES} bytes` }],
                isError: true
            };
        }

        const logs: string[] = [];
        const executionStart = Date.now();
        let operationCount = 0;

        const serverNames = new Set<string>([
            ...this.serverManager.getLoadedServers().keys(),
            ...this.serverManager.getLazyServers()
        ]);

        // Build per-server proxies
        const serversAPI: Record<string, any> = {};
        for (const name of serverNames) {
            serversAPI[name] = new Proxy({}, {
                get: (_target, prop) => {
                    if (prop === "then" || typeof prop !== "string") return undefined;
                    return async (rawArgs: any) => {
                        operationCount++;
                        const server = await this.serverManager.ensureServerLoaded(name);
                        const tool = server.tools.find((t) => t.name === prop);
                        if (!tool) throw new Error(`Tool "${prop}" not found on server "${name}"`);
                        const args = this.pathNormalizer.normalizeArguments(rawArgs);
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
                    const output = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(" ");
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
                const result = await toolRegistry.getToolAPI(params.serverName);
                return this.unwrapMCPResult(result);
            },
            search_tools: async (params: any) => {
                const result = await toolRegistry.searchTools(params.query, params.detailLevel || "name+description");
                return this.unwrapMCPResult(result);
            }
        };

        // Track timers
        const timers: NodeJS.Timeout[] = [];
        const intervals: NodeJS.Timeout[] = [];

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
            codeGeneration: { strings: false, wasm: false }
        });
        // Limit access to host globals inside the VM
        Object.defineProperty(context, "globalThis", { value: sandbox, writable: false, configurable: false });
        Object.defineProperty(context, "global", { value: sandbox, writable: false, configurable: false });
        (context as any).Function = undefined;
        (context as any).eval = undefined;

        try {
            const wrappedCode = `(async () => { ${code} })()`;
            const result = await vm.runInContext(wrappedCode, context, { timeout: TIMEOUTS.CODE_EXECUTION_TIMEOUT_MS });

            const executionTime = Date.now() - executionStart;
            const normalizedResult = this.pathNormalizer.normalizePathsInResult(result);
            const safeResult = normalizedResult === undefined ? null : normalizedResult;

            const originalSize = JSON.stringify(safeResult).length;
            const formattedResult = TOONEncoder.encode(safeResult);
            const compressedSize = formattedResult.length;
            const savings = originalSize > 0 ? ((1 - compressedSize / originalSize) * 100).toFixed(1) : "0.0";

            const sections: string[] = [];
            if (logs.length) sections.push(`Logs:\n${logs.join("\n")}`);
            sections.push(`Result (TOON):\n${formattedResult}`);

            sections.push(`---
EFFICIENCY REPORT:
• Operations: ${operationCount}
• Original: ${originalSize} bytes
• Compressed: ${compressedSize} bytes
• Savings: ${savings}%
• Time: ${executionTime}ms
${Number(savings) < 20 ? '\nNOTE: Low compression suggests unstructured data. TOON works best on JSON/structured data.' : ''}`);

            return {
                content: [{ type: "text", text: sections.join("\n\n") }]
            };
        } catch (err: any) {
            return {
                content: [{ type: "text", text: `Execution error: ${err.message}\n\nLogs:\n${logs.join("\n")}` }],
                isError: true
            };
        } finally {
            timers.forEach(clearTimeout);
            intervals.forEach(clearInterval);
        }
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
