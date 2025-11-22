// Constants for timeouts and limits
export const TIMEOUTS = {
    // Server loading timeouts
    HANDSHAKE_TIMEOUT_MS: 5_000,      // 5s for initial handshake
    TOOLS_LIST_TIMEOUT_MS: 120_000,   // 120s for tools/list (slow servers like uvx)
    TOOL_CALL_TIMEOUT_MS: 60_000,     // 60s for individual tool calls
    HTTP_REQUEST_TIMEOUT_MS: 30_000,  // 30s for HTTP MCP requests

    // Shutdown timeouts
    SHUTDOWN_GRACE_MS: 500,           // 500ms to wait for shutdown response
    FORCE_KILL_MS: 1_000,             // 1s before force killing child process

    // Execution limits
    CODE_EXECUTION_TIMEOUT_MS: 60_000 // 60s for VM code execution
} as const;

export const LIMITS = {
    CODE_SIZE_BYTES: 100_000          // 100KB max code size
} as const;
