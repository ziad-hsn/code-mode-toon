# CodeModeTOON MCP Server

CodeModeTOON is a lightweight Model Context Protocol (MCP) orchestrator focused on token efficiency, lazy tool discovery, and cross‑platform stability. Built in TypeScript for rapid use inside agents like Codex/Claude.

## TL;DR
> TOON-compressed MCP orchestrator with lazy MCP loading, execute_code sandbox, and cross-platform path normalization for agent workflows.

## Highlights
- TOON compression for tool schemas/results (message size reduction advertised at ~99.8%) with helper encoders.
- Sandboxed `execute_code` that exposes MCP tools via a small JS API, plus `search_tools`, `get_tool_api`, `list_servers`, and `set_project_root`.
- Lazy load support for MCP servers; eager loading for critical ones; clear logging for startup timing.
- Cross‑platform path normalization (Windows drive letters, file:// URIs) and graceful shutdown of child MCP processes.
- Designed for SRE/dev workflows where fast iteration, observability, and token savings matter.

## Why TOON?
**TOON (Token-Oriented Object Notation)** is a data format designed to minimize token usage for LLMs. By removing redundant syntax like braces and quotes, it often achieves **30-70% reduction** compared to JSON. This means your agent can "see" more tools and process data faster without hitting context limits.

## Quick Start
```bash
npm install
npm run build
# Provide your config path (examples below)
node dist/code-mode-toon-server.js ./mcp-servers-config.json
```

Once running, your MCP client will see tools like `execute_code`, `search_tools`, and `get_tool_api`. Use `list_tools` from the client to confirm.

## Example Config (sanitized)
See `samples/mcp-servers-config.example.json` for a safer starting point. Key fields:
- `command` / `args`: how to start each MCP server (stdio).
- `env`: API keys or other secrets (do not commit real values).
- `lazy`: `true` defers startup until first call; otherwise loads at boot.
- `priority`: optional label to mark critical servers for eager loading.

## Usage Examples
- Discover tools quickly:
  - Call `search_tools` with a keyword to get names/descriptions.
  - Call `get_tool_api` to pull full input schema for a specific server.
- Orchestrate via `execute_code` (runs inside a vm sandbox):
  ```ts
  // Sample code to run through execute_code
  const api = await get_tool_api({ serverName: 'go-development' });
  console.log(api);

  const search = await search_tools({ query: 'diag', detailLevel: 'full' });
  console.log(search);
  ```
- Adjust paths per workspace:
  - Call `set_project_root` before invoking tools so relative paths resolve correctly across Windows/Linux.

## Architecture (text)
- Transport: stdio via `@modelcontextprotocol/sdk` server.
- Loader: starts MCP servers from JSON config; supports lazy load with on-demand connection.
- Execution: vm sandbox exposes MCP tools as async functions (`servers[serverName].tool(...)`).
- TOON: encodes schemas/results for reduced token usage when requested.
- Cleanup: tracks child processes and issues graceful shutdown/exit notifications.

## HTTP transport notes (MCP 2025 streamable)
- POST endpoint for JSON-RPC messages; optional GET with `text/event-stream` for SSE back to client.
- Keep initialization handshake intact (initialize → capabilities → initialized notification).
- Works statelessly; handy for remote-hosted MCPs (e.g., Cloudflare/Koyeb) without sockets.
- If you expose server-originated events (tool availability, progress), stream them over SSE.

## Helpful MCP doc tools bundled
- `aws-documentation`: search/read official AWS docs in markdown form.
- `documcp` / `web-research` / `perplexity`: augment README examples or clarify MCP transport specs.

## Acknowledgments
- Anthropic: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Cloudflare: [Code Mode announcement](https://blog.cloudflare.com/code-mode/)
- YouTube walkthrough: [Code Mode demo](https://youtu.be/1piFEKA9XL0)
- Community signal boost: [DataChaz](https://x.com/datachaz/status/1989056483057889481?s=46)

## Author
Built by **Ziad Hassan** (Senior SRE/DevOps) — [LinkedIn](https://www.linkedin.com/in/ziad-hassan-334688216/) · [GitHub](https://github.com/ziad-hsn).

## Contributing
Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
