# Forge Agent

**An editor-native coding agent for VS Code whose agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge).** Built by **THE AGENTIC ORDER** for the
TrueFoundry Forge-a-thon (Techfest 2026-27, IIT Bombay).

The extension is a **client of a TrueForge agent**:
- It creates TrueForge sessions, sends turns over TrueForge's HTTP API, and renders the streamed
  events in the editor.
- The editor's capabilities are exposed to the agent as **MCP tools**, served by the extension itself.
  The agent, running inside TrueForge, decides what to read.
- The extension never calls a model provider. Models are configured in TrueForge.

```
VS Code ── Forge Agent extension ──────────────────────────────┐
│  Agent panel (webview)  ⇄  TrueForge client (HTTP + SSE)       │
│                                   │ sessions / turns / cancel  │
│  Editor MCP server  ◀─────────────┼──── tool calls (MCP over   │
│  127.0.0.1:<port>/mcp, bearer key │     Streamable HTTP)       │
└───────────────────────────────────┼────────────────────────────┘
                                    ▼
                      TrueForge (local mode, :8790)
                      agent loop · sessions · streaming
                                    │
                                    ▼
                   any model configured in TrueForge
```

## Status
Milestone 1 (walking skeleton):
- Agent panel with token streaming and Stop (cancels the turn in TrueForge).
- Read-only editor tools: `list_files`, `read_file`, `search_code` (ripgrep, with a built-in fallback).

Next: inline edit, per-hunk diff review driven by TrueForge tool approvals, context retrieval with a
budget, and model fallback.

## Starting point
**From scratch.** No upstream editor project was forked.

## Requirements
- **Node.js ≥ 22.14** (TrueForge's requirement; the extension builds with any Node ≥ 20)
- **VS Code ≥ 1.90**
- A model reachable by TrueForge. Any OpenAI-compatible endpoint, or a native provider (OpenAI,
  Anthropic, Gemini, Z.ai, …). See [Model setup](#model-setup).

## Setup from a clean clone
```bash
git clone https://github.com/Aditya-Lingam-9000/TrueFoundry-Forge-a-thon.git
cd TrueFoundry-Forge-a-thon
npm install
npm run compile
```

### 1. Start TrueForge locally (terminal 1, leave it running)
```bash
bash scripts/start-trueforge.sh
```
This runs `npx @truefoundry/trueforge@0.182.0` (pinned) on `http://localhost:8790` with
`OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"]`. TrueForge must be allowed to call the
extension's MCP server on 127.0.0.1.

### 2. Configure a model in TrueForge (terminal 2)
```bash
cp config/models.example.json config/models.json   # git-ignored; edit base URLs, delete unused providers
export FORGE_API_KEY=...                            # every key the file references as ${VAR}
node scripts/register-models.mjs
```
Or add the provider in the TrueForge UI under Settings → Model providers.

### 3. Run the extension
Open this folder in VS Code and press **F5** ("Run Forge Agent").
- A new VS Code window opens with the extension loaded and `../repos/flask-3.1.3` as its workspace.
  Edit `.vscode/launch.json` to open another repository.
- Open the **Forge Agent** view in the activity bar and ask about the repository, e.g.
  *"Where is `get_debug_flag` defined and what does it do?"*
- **Open in TrueForge** (panel header) shows the same session in TrueForge's UI: turns, tool calls,
  timings.

### Agent definition
[`agent/forge-agent.json`](agent/forge-agent.json) is the TrueForge agent spec the extension
sends inline when it creates a session.
- The model comes from the spec, or from the `forgeAgent.model` setting (`<provider>/<model>` as
  configured in TrueForge).
- The `forge-editor` MCP server is registered automatically when the extension starts.

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `forgeAgent.trueforgeUrl` | `http://localhost:8790` | TrueForge base URL |
| `forgeAgent.model` | *(empty → spec)* | Model override, `<provider>/<model>` |
| `forgeAgent.agentDefinition` | *(bundled spec)* | Path to another agent spec |
| `forgeAgent.mcpServerName` | `forge-editor` | Name of the editor MCP server in TrueForge |

## Model setup
The extension works with whatever model TrueForge is configured with.
- During development we serve open models on free Kaggle accelerators behind an authenticated
  OpenAI-compatible endpoint: Qwen3-Coder-30B on 2×T4 via Ollama, and Qwen3.8-27B on a TPU v5e-8
  via vLLM.
- Cost: ₹0.
- Switching models: change `forgeAgent.model`, or the `model.name` in the agent spec.

## Development
```bash
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```
Logs: **Forge Agent: Show Log** (command palette).

## License
[MIT](LICENSE) © 2026 THE AGENTIC ORDER
