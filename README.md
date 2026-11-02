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
- **Agent panel** with token streaming and **Stop**. Stop cancels the turn inside TrueForge, kills
  running commands and closes open reviews; nothing unapproved is written.
- **Editor tools (MCP):** `list_files`, `read_file`, `search_code` (ripgrep, with a built-in fallback).
- **Edits with per-hunk review, driven by TrueForge tool approval.**
  - `propose_write` is gated by TrueForge (`require_approval_for_tools`).
  - When the agent calls it, TrueForge pauses the turn and the extension opens the proposal as a
    diff, with ✓ Accept / ✗ Reject above each hunk (plus Accept all / Reject all / side-by-side).
  - The decisions go back to TrueForge as approvals. Only the accepted hunks are written, as one
    atomic edit, and the agent is told exactly which hunks were rejected.
  - Undo with Cmd/Ctrl+Z in the file, or with **Forge Agent: Revert Last Agent Change** (also works
    after saving).
- **`run_command`** (e.g. tests), approved per command in the panel, with live output in the
  "Forge Agent: Commands" channel.
- **Inline edit (Cmd/Ctrl+I, or right-click → Forge Agent: Inline Edit…):** select code, type an
  instruction, review the diff beside the file, accept or reject each hunk.
  - Each inline edit is one fresh, lean TrueForge session ([`agent/inline-edit.json`](agent/inline-edit.json)).
    It gets the selection plus 15 lines of context, and only `propose_write` (plus `read_file`/`search_code`
    if really needed).
  - The edit is anchored to the selected lines, so a repeated snippet elsewhere can't be hit. Any
    change outside the selection is refused before the user sees it.
  - Progress streams in a cancellable notification and in the agent panel. A failing model shows a
    clear error, and nothing is written.

Next: context retrieval with a budget, model fallback.

### How a reviewed edit flows
```
agent (in TrueForge) ──propose_write──▶ TrueForge pauses: tool.approval_required
        ▲                                         │
        │                                         ▼
        │                    extension opens the review (hunk by hunk, nothing written)
        │                                         │ user decides each hunk
        │                                         ▼
        └──── tool result: "applied 2 of 3 hunks; rejected …" ◀── user.tool_approval (allow / deny)
                         ▲                                         │
                         └── MCP propose_write writes ONLY the accepted hunks (one atomic WorkspaceEdit)
```

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
This runs `npx @truefoundry/trueforge@0.182.0` (pinned) on `http://127.0.0.1:8790` with
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
- A new VS Code window opens with the extension loaded and `../repos/flask-work` (a working clone
  of pallets/flask at tag 3.1.3) as its workspace. Edit `.vscode/launch.json` to open another
  repository.
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
| `forgeAgent.trueforgeUrl` | `http://127.0.0.1:8790` | TrueForge base URL |
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
npm test            # unit tests (diff/hunk engine)
npm run check       # typecheck + build + tests
```
Logs: **Forge Agent: Show Log** (command palette).

## License
[MIT](LICENSE) © 2026 THE AGENTIC ORDER
