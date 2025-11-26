import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import * as os from "os";
import { PathNormalizer } from "./components/path-normalizer.js";
import { ConfigManager } from "./components/config-manager.js";
import { MCPServerManager } from "./components/mcp-server-manager.js";
import { CodeExecutor } from "./components/code-executor.js";
import { ToolRegistry } from "./components/tool-registry.js";
import { WorkflowManager } from "./components/workflow-manager.js";

class CodeModeServer {
  private static readonly ORCHESTRATOR_VENDOR = "code-mode-toon";
  private static readonly ORCHESTRATOR_SIGNATURE = "code-mode-toon-orchestrator-v1";

  private server: Server;
  private configManager: ConfigManager;
  private pathNormalizer: PathNormalizer;
  private serverManager: MCPServerManager;
  private codeExecutor: CodeExecutor;
  private workflowManager: WorkflowManager;
  private toolRegistry: ToolRegistry;

  private constructor(configPath: string) {
    this.server = new Server(
      {
        name: "code-mode-toon",
        version: "1.0.0",
        vendor: CodeModeServer.ORCHESTRATOR_VENDOR,
        signature: CodeModeServer.ORCHESTRATOR_SIGNATURE
      },
      { capabilities: { tools: {} } }
    );

    this.configManager = new ConfigManager(configPath);
    this.pathNormalizer = new PathNormalizer(this.configManager.getProjectRoot());
    this.serverManager = new MCPServerManager(this.configManager, this.pathNormalizer);
    this.codeExecutor = new CodeExecutor(this.serverManager, this.pathNormalizer);
    this.workflowManager = new WorkflowManager(this.configManager, this.serverManager, this.pathNormalizer);
    this.toolRegistry = new ToolRegistry(this.server, this.configManager, this.serverManager, this.codeExecutor, this.workflowManager);
  }

  static async create(configPath: string): Promise<CodeModeServer> {
    const instance = new CodeModeServer(configPath);
    await instance.configManager.loadConfig();

    // Re-initialize PathNormalizer with potentially updated project root from config
    instance.pathNormalizer = new PathNormalizer(instance.configManager.getProjectRoot());

    // Re-wire dependencies that need the updated normalizer/config
    // Note: In a true DI system this would be cleaner, but for now we just update references if needed.
    // Actually, since we passed the instances by reference (except projectRoot string), 
    // we might need to update the projectRoot in the normalizer if it changed.
    // But PathNormalizer takes projectRoot in constructor. Let's just re-create components that depend on it.

    instance.serverManager = new MCPServerManager(instance.configManager, instance.pathNormalizer);
    instance.codeExecutor = new CodeExecutor(instance.serverManager, instance.pathNormalizer);
    instance.workflowManager = new WorkflowManager(instance.configManager, instance.serverManager, instance.pathNormalizer);
    instance.toolRegistry = new ToolRegistry(instance.server, instance.configManager, instance.serverManager, instance.codeExecutor, instance.workflowManager);

    await instance.workflowManager.loadWorkflows();
    instance.toolRegistry.setupHandlers();
    instance.setupProcessHandlers();
    return instance;
  }

  private setupProcessHandlers() {
    const cleanup = async () => {
      await this.serverManager.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  async start() {
    const transport = new StdioServerTransport();

    this.server.oninitialized = async () => {
      console.error("[CodeMode+TOON] Client initialized. Loading downstream servers...");
      await this.serverManager.loadServers();
      console.error("[CodeMode+TOON] Server ready!");
    };

    await this.server.connect(transport);
    console.error("[CodeMode+TOON] MCP transport connected. Waiting for client initialization...");
  }
}

const defaultConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
const rawConfigPath = process.argv[2] || process.env.CODE_MODE_TOON_CONFIG || defaultConfigPath;
const resolvedConfigPath = path.resolve(PathNormalizer.expandPath(rawConfigPath));

console.error(`[CodeMode+TOON] Using config: ${resolvedConfigPath}`);

CodeModeServer.create(resolvedConfigPath)
  .then(server => server.start())
  .catch(console.error);
