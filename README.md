# CodeModeTOON MCP Server

A lightweight Model Context Protocol (MCP) orchestrator with TOON compression, lazy MCP loading, and a sandboxed `execute_code` tool for AI assistants.

## Key Features

- **Orchestration**: Load multiple MCP servers (stdio/HTTP) under one unified endpoint.
- **Smart Loop Prevention**: Handshake-based detection prevents infinite recursion if CodeModeTOON is nested within itself.
- **Lazy Loading**: Defers server startup until tools are actually requested.
- **TOON Compression**: Reduces token usage by 30-70% for large JSON responses.
- **Secure-ish Execution**: Sandboxed JS execution with access to downstream tools.

## Installation

### One‑Click (Cursor)

[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-blue?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/en-US/install-mcp?name=code-mode-toon&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvZGUtbW9kZS10b29uIl19)

This button loads CodeModeTOON using your existing Cursor MCP configuration at `~/.cursor/mcp.json`. After clicking it, restart Cursor so the new server appears in the MCP panel.

### Manual (Cursor Settings → MCP)

Add this snippet to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "code-mode-toon": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "code-mode-toon"],
      "env": {
        "CODE_MODE_TOON_CONFIG": "~/.cursor/mcp.json"
      }
    }
  }
}
```

> Tip: If you prefer a dedicated config file, change the env var to `~/.cursor/code-mode-toon-config.json` and copy the MCP server list from `samples/mcp-servers-config.example.json`.

### Important: Run via MCP Client Only

CodeModeTOON requires an active MCP client (like Cursor or Claude Desktop) to function. It cannot be run directly in the terminal because it relies on the client's initialization handshake to verify identity and prevent infinite spawn loops.

## Usage Example

```javascript
// Inside execute_code
const api = await get_tool_api({ serverName: 'go-development' });
const result = await servers['go-development'].check_diagnostics({ file: 'main.go' });
console.log(result);
```

## Security Note

**⚠️ The `vm` module is NOT a security sandbox.** Suitable for personal AI assistant use (Claude, Cursor) with trusted code. Not for multi-tenant or public services.

## Acknowledgments
- Anthropic: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Cloudflare: [Code Mode announcement](https://blog.cloudflare.com/code-mode/)
- YouTube walkthrough: [Code Mode demo](https://youtu.be/1piFEKA9XL0)

## Author
Built by **Ziad Hassan** (Senior SRE/DevOps) — [LinkedIn](https://www.linkedin.com/in/ziad-hassan-334688216/) · [GitHub](https://github.com/ziad-hsn)

## License
MIT License — see [LICENSE](LICENSE) for details.
