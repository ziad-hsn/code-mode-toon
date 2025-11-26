import { readFile } from "fs/promises";
import { PathNormalizer } from "./path-normalizer.js";

export interface MCPServer {
    name: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    priority?: string;
    lazy?: boolean;
    disabled?: boolean;
}

export interface CodeModeConfig {
    enableTOON: boolean;
    projectRoot: string;
}

export interface ServerConfig {
    mcpServers: Record<string, MCPServer>;
    optimizations?: Record<string, any>;
}

export class ConfigManager {
    private config!: ServerConfig;
    public codeModeConfig: CodeModeConfig;

    constructor(private configPath: string) {
        this.codeModeConfig = {
            enableTOON: true,
            projectRoot: process.env.PROJECT_ROOT || process.cwd()
        };
    }

    async loadConfig(): Promise<void> {
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

            // Expand project root path
            this.codeModeConfig.projectRoot = PathNormalizer.expandPath(this.codeModeConfig.projectRoot);

        } catch (error) {
            console.error(`[CodeMode+TOON] Failed to load config from ${this.configPath}, using defaults. Error: ${error}`);
            this.config = { mcpServers: {} };
        }
    }

    getMCPServers(): Record<string, MCPServer> {
        return this.config.mcpServers || {};
    }

    getProjectRoot(): string {
        return this.codeModeConfig.projectRoot;
    }

    setProjectRoot(path: string): void {
        this.codeModeConfig.projectRoot = path;
    }
}
