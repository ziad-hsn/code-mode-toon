# CodeModeTOON MCP Server

<!-- ![CI Status](https://github.com/ziad-hsn/code-mode-toon/actions/workflows/ci.yml/badge.svg) -->
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![NPM Version](https://img.shields.io/npm/v/code-mode-toon.svg)

A lightweight **Model Context Protocol (MCP)** orchestrator designed for **efficiency at scale**. It features **TOON compression** (reducing token usage by 30-70%) and **Lazy Loading**, making it the ideal solution for complex, multi-tool agentic workflows.

## The "Context Trap" in Agentic Workflows

Recent research from **Anthropic** and **Cloudflare** highlights a critical bottleneck: **AI agents struggle with complex, multi-step workflows because they lack state.**

While **Code Execution** (e.g., TypeScript) allows agents to maintain state and structure workflows effectively, it introduces a new problem: **Data Bloat**. Real-world operations (like SRE log analysis or database dumps) generate massive JSON payloads that explode the context window, making stateful execution prohibitively expensive.

**CodeModeTOON** bridges this gap. It enables:
1.  **Stateful Execution**: Run complex TypeScript workflows to maintain context *outside* the model.
2.  **Context Efficiency**: Use **TOON Compression** to "zip" the results, allowing agents to process massive datasets without blowing their token budget.

### Key Features

- **TOON Compression**: Reduces token usage by **30-90%** for structured data (validated: **92% savings** on Kubernetes audits).
- **Lazy Loading**: Defers server startup until tools are actually requested.
- **Sandboxed Execution**: Secure JS execution with auto-proxied MCP tool access.

## Installation

### One‑Click (Cursor)

[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-blue?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/en-US/install-mcp?name=code-mode-toon&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvZGUtbW9kZS10b29uIl19)

### Manual Setup

Add this to your `~/.cursor/mcp.json`:

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

## Usage Example

**Optimized Tool Execution with TOON Compression:**

```javascript
// Inside execute_code
const api = await get_tool_api({ serverName: 'perplexity' });

// Request large data - automatically compressed!
const result = await servers['perplexity'].perplexity_ask({
  messages: [{ role: 'user', content: "Summarize the history of Rome" }]
});

console.log(result); // Returns TOON-encoded string, saving ~40% tokens
```

## Workflows

CodeModeTOON supports **Workflows**—pre-defined, server-side TypeScript modules that orchestrate multiple MCP tools.

### Research Workflow
A powerful research assistant that:
- **Parallelizes** data fetching from multiple sources (Context7, Wikipedia, Perplexity).
- **Synthesizes** findings using LLMs (optional).
- **Outputs TOON-encoded files** for maximum context efficiency.
- **Retries** failed requests automatically.

See [WORKFLOW_USAGE.md](WORKFLOW_USAGE.md) for detailed documentation.

## Performance Benchmark

**Scenario 1: Natural Language Query (History of Rome)**
*Unstructured text compresses poorly, as expected.*
- **Original JSON**: 11,651 chars
- **TOON Encoded**: 11,166 chars
- **Compression Ratio**: **~4.16% Savings**

**Scenario 2: Kubernetes Cluster Audit (50 Pods)**
*Highly structured, repetitive JSON (infrastructure dumps) compresses extremely well.*
- **Original JSON**: 37,263 chars
- **TOON Encoded**: 2,824 chars
- **Compression Ratio**: **92.42% Savings** 📉

*Key Takeaway: CodeModeTOON is optimized for the heavy, structured data that usually clogs agent contexts.*

## Security Note

**⚠️ The `vm` module is NOT a security sandbox.** Suitable for personal AI assistant use (Claude, Cursor) with trusted code. Not for multi-tenant or public services.

## Acknowledgments
- Anthropic: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Cloudflare: [Code Mode announcement](https://blog.cloudflare.com/code-mode/)

## Author
Built by **Ziad Hassan** (Senior SRE/DevOps) — [LinkedIn](https://www.linkedin.com/in/ziad-hassan-334688216/) · [GitHub](https://github.com/ziad-hsn)

## License
MIT License — see [LICENSE](LICENSE) for details.
