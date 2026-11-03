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
  - Several proposals for one file in the same step become one review with all their hunks. If
    their edits conflict, the first is reviewed and the others go back to the agent.
  - Undo with Cmd/Ctrl+Z in the file, or with **Forge Agent: Revert Last Agent Change** (also works
    after saving).
- **`run_command`** (e.g. tests, linters), approved per command in the panel, with live output in the
  "Forge Agent: Commands" channel.
  - Every file change goes through a reviewed `propose_write`, so linters and formatters always run
    in check mode (`ruff check --no-fix`, `ruff format --check`, `black --check`, …). The approval
    card shows the exact command that will run.
  - Commands that can discard uncommitted work (`git checkout/clean/reset/restore/stash`) and
    `pre-commit run` are refused.
- **Project conventions:** the agent also updates every place where similar features are listed
  (API reference, changelog), and runs the project's linters on the files it changed before it answers.
- **Done-check (enforced by the editor, not left to the model):** when a chat request changed source
  files and the agent says it is finished, the editor checks what was actually done.
  - It checks for a changed test, tests and linters run after the last write, a docs change, and
    the changelog when the project keeps one.
  - The gaps go back to the agent once, as a 🔎 card: it fixes each one or says why it does not apply.
- **Inline edit (Cmd/Ctrl+I, or right-click → Forge Agent: Inline Edit…):** select code, type an
  instruction, review the diff beside the file, accept or reject each hunk.
  - Each inline edit is one fresh, lean TrueForge session ([`agent/inline-edit.json`](agent/inline-edit.json)).
    It gets the selection plus 15 lines of context, and only `propose_write` (plus `read_file`/`search_code`
    if really needed).
  - The edit is anchored to the selected lines, so a repeated snippet elsewhere can't be hit. Any
    change outside the selection is refused before the user sees it.
  - Progress streams in a cancellable notification and in the agent panel. A failing model shows a
    clear error, and nothing is written.

- **Explicit context with @-mentions:** write `@src/flask/cli.py`, `@cli.py` or `@routes_command` in a chat
  message. The file (whole if short, otherwise its outline) or the symbol's definition is attached
  within a budget (`forgeAgent.mentionBudgetTokens`), and a 📎 card shows what was resolved.
- **Automatic context:** for every chat message, the editor ranks the repository against your exact
  words and attaches the best chunks within `forgeAgent.autoContextTokens` (default 2,500). They show
  as a 🧭 *Auto context* card.
- **Context retrieval with a token budget:** `retrieve_context` and `file_outline` (see below). Every
  plan appears in the panel as a **Context Plan** card, showing the files and line ranges chosen,
  why each was chosen, and the tokens used against the budget.
- **Scout sub-agent (TrueForge dynamic sub-agents):** for multi-file tasks the agent delegates
  discovery to a sub-agent named "scout". It explores with the read-only tools and reports back only
  `path:lines — why`, so the main agent's context stays small. The scout shows as its own thread in
  the TrueForge session and as a card in the panel.
  - For a chat request that creates something across several files (it mentions tests or docs, or a
    sibling pattern was found), the editor ends the message with the exact first step. That step is
    a `create_sub_agent` call with the request word for word, plus the scout's brief: start with
    `retrieve_context`, at most 8 tool calls.
  - A rule in the system prompt alone was followed only some of the time; the latest user message
    is followed far more reliably.

- **Automatic model fallback (Task C).** TrueForge has no model fallback, so the editor drives it.
  - A model error before anything was written: an invalid key, an unreachable endpoint, or a rate
    limit that is still there after one retry 3 s later.
  - The editor switches the TrueForge session to the next model in `forgeAgent.fallbackModels`
    (`PATCH /sessions/{id}` with the new model) and sends the request again from the last good
    turn. The user does nothing.
  - A ⚠ card in the panel and a toast say which model failed, why, and which one took over.
    Inline edits (Cmd+I) use the same path.
  - Every session's `max_tokens` is capped at the output limit its model declares in TrueForge
    (`max_output_tokens`). A thinking fallback model keeps its full budget, and a free tier that counts
    requested tokens per minute (Groq) gets a small one.
  - If every model fails, the user gets one clear message listing each model and its error.
    Nothing is written before review, so `git status` stays clean.
  - `node scripts/simulate-failure.mjs invalid-key|unreachable` breaks the primary provider for a
    demo; `node scripts/register-models.mjs --env ../.env` restores it.

### How context is selected
The repository is larger than the model's context, so the agent never reads it wholesale.
`retrieve_context(query, budget_tokens)` works in five steps:
1. **Terms.** Identifiers and keywords from the request (snake/camel parts, light stemming,
   stop-words removed).
2. **Candidates.**
   - Files with ripgrep hits, weighted by how rare each term is across the repository.
   - Files whose path contains a term.
   - The tests and docs of the best implementation files (`tests/test_<name>.py`,
     `docs/<name>.rst`, …).
3. **Sibling pattern.** A request that *adds* something ("add a new built-in CLI command …") is
   best served by the existing things of the same kind, not by files that share a word with the new
   name. Words like "config" match `config.py` and `docs/config.rst`, but those are not where a
   command goes.
   - A *family* is two or more top-level definitions whose names share an affix that the request
     uses as a plain word: `run_command`, `shell_command`, `routes_command` for "command".
   - The editor then finds:
     - the line that registers the family together (`FlaskGroup.__init__`);
     - the files that name its members (their tests, `docs/api.rst`);
     - the test class named after a member (`TestRoutes`);
     - doc sections about a member ("Open a Shell").
   - Only for requests that create something. Generic prefixes (`get_`, `set_`, `is_`, …) never form
     a family, and a doc heading that merely shares a word with a member does not count.
4. **Chunks and ranking.** Candidates are split at function/class/heading boundaries. A small class
   stays one chunk, so a test class arrives whole; methods of a large class are named after it
   (`FlaskGroup.__init__`). Chunks are scored with BM25. A chunk scores higher when it defines a
   matching name, when its path matches, when it is a test/doc companion, and when it belongs to the
   sibling pattern.
5. **Packing.**
   - The sibling pattern goes in first: the registration site, one existing member, its test and its
     docs, up to 60% of the budget.
   - Then the best chunk of each other top file, then the rest by score.
   - Oversized chunks are trimmed: a class keeps its head (class line and fixtures), other chunks
     their densest window. Tokens are estimated at about 4 characters each.

For Task B (budget 2,500), this gives the agent `FlaskGroup.__init__` ("where the existing commands
are registered"), `shell_command` ("an existing command like the requested one"), `TestRoutes`
("tests the existing command routes") and "Open a Shell" ("documents the existing command shell").
Before this step, the first three files were `config.py`, `docs/config.rst` and `test_config.py`.
The Context Plan card shows each choice with its reason and the pattern it followed.

The default budget is 4,000 tokens (`forgeAgent.contextBudgetTokens`, at most 4,500, because TrueForge refuses a single tool result over 24,000 characters). The tool result lists every
chunk with its score and its reasons. After that the agent reads only precise ranges
(`file_outline`, `read_file` with `start_line`/`end_line`). `read_file` on a file over 250 lines without a range returns the file's outline instead of a page. TrueForge's compaction keeps long
sessions within the window.

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
This runs `npx @truefoundry/trueforge@0.182.0` (pinned) on `http://127.0.0.1:8790`.
- `OUTBOUND_URL_ALLOWED_HOSTS` includes 127.0.0.1, so TrueForge may call the extension's MCP server.
- It also includes the model API hosts (NVIDIA, Z.ai, Groq, Mistral). On IPv6-only networks with
  NAT64, these hosts resolve to `64:ff9b::` addresses, which TrueForge's outbound guard otherwise
  refuses. Add more hosts with `EXTRA_ALLOWED_HOSTS='"api.example.com"'`.

### 2. Configure a model in TrueForge (terminal 2)
```bash
cp config/models.example.json config/models.json   # git-ignored; edit base URLs, delete unused providers
echo 'NVIDIA_KEY=nvapi-...' >> .env                 # git-ignored; every key the file references as ${VAR}
echo 'GROQ_API_KEY=gsk_...' >> .env                # optional: second fallback vendor
node scripts/register-models.mjs --env .env
```
Keys can also be exported instead of written to `.env`. The script never prints them.
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
| `forgeAgent.fallbackModels` | `nvidia-backup/nemotron-3-5-lightning`, `groq/gpt-oss-120b` | Models that take over automatically, in order |
| `forgeAgent.mcpServerName` | `forge-editor` | Name of the editor MCP server in TrueForge |

## Model setup
The extension works with whatever model TrueForge is configured with.
- **Default: `nvidia/nemotron-3-5-super`.** This is NVIDIA's Nemotron 3.5 Super VL (120B MoE,
  12B active) on the free NVIDIA API tier (build.nvidia.com: 40 requests/min).
  - It reasons before it answers, also when tools are offered, at about 70–220 tokens/s.
  - Its planning steps can think for several thousand tokens, so the specs set `max_tokens` to 16384.
    A lower limit can leave an empty answer.
- **Fallback chain** (`forgeAgent.fallbackModels`):
  1. `nvidia-backup/nemotron-3-5-lightning`: Nemotron 3.5 Lightning (30B MoE, 3B active). It is
     registered as a separate provider entry, so a broken key or URL on the primary entry does not
     break it.
  2. `groq/gpt-oss-120b`: a second vendor. Its free tier allows 8,000 tokens per minute, enough
     for small edits (Task A), not for long multi-file tasks.
- `nvidia/minimax-m3-1-flash` is also registered, but it is often very slow on the free tier.
- **Self-hosted alternative:** open models on free Kaggle accelerators behind an authenticated
  OpenAI-compatible endpoint: Qwen3-Coder-30B on 2×T4 via Ollama, Qwen3.8-27B on a TPU v5e-8 via
  vLLM. Qwen3-Coder-30B handles single-file edits, but not multi-file tasks.
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
