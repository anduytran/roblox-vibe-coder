# Hangar

A desktop control room for Claude-powered game development. Each project folder (for example a Rojo repo) gets its own team of agents — a general **Main** agent plus any roles you define (Lead, Scripter, UI Builder, QA Tester…) — running on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), with Roblox Studio connected through its built-in MCP server.

Built for personal use first; packaging for a downloadable installer is set up but not yet signed.

## What it does

- **Projects sidebar** — one entry per folder, with live dots for working agents and a badge when something needs your approval.
- **Agent board** — every agent's status (idle, queued, working, needs approval, error), current activity, queue and session cost.
- **Live feed and chat** — messages, tool calls, results and errors as they happen. Sending while an agent is busy queues the task.
- **Roles as files** — roles are `.claude/agents/<id>.md` in the project, the same format Claude Code uses, so they're versioned with your game. "Add starter roles" creates four templates.
- **Approvals** — anything that changes things asks first (see *Safety model*). "Always allow" is saved per project and can be removed in Project settings.
- **Changes tab** — git diff of everything agents changed, commit all, or revert a single file (new files go to the OS trash, never hard-deleted).
- **Spending controls** — per-task limit, daily limit across projects, optional daily limit per project, and a **Stop all agents** button.
- **Sessions resume** — each agent continues its conversation across tasks and app restarts until you click *New session*.

## Requirements

- Node.js 20 or newer
- Git
- An Anthropic API key (Claude Console → API keys). The Agent SDK requires API-key authentication for third-party apps; claude.ai subscription login isn't available here.
- Roblox Studio (optional, for Studio tools), with **Assistant → … → Manage MCP Servers → Enable Studio as MCP server** turned on.

## Run it

```bash
npm install
npm run dev
```

Then in the app:

1. **Settings** → paste your API key.
2. **+ Add project** → pick your game's folder (ideally a git repo; the Changes tab can initialize one).
3. **Add starter roles**, pick an agent, and give it a small, specific task.

Put a `CLAUDE.md` in the project root with your conventions (folder layout, module patterns, how augments work, "playtest after every change"). Every agent reads it.

Extra MCP servers (e.g. Blender) go in the project's `.mcp.json` under `mcpServers`.

### Other scripts

```bash
npm run typecheck   # TypeScript, main + renderer
npm test            # unit tests (policy, git, roles, costs, agent queue/approvals)
npm run dist:win    # Windows installer (run on Windows)
npm run dist:mac    # macOS .dmg (run on a Mac)
```

Commit `package-lock.json` after the first install so the exact SDK version is pinned.

## Safety model

Agents run with the project folder as their working directory, and every tool call that isn't clearly safe goes through Hangar's policy (`src/main/permissions.ts`):

| Action | Default |
| --- | --- |
| Reading/searching inside the project | Allowed |
| Read-only Roblox Studio tools (game tree, console output, screenshots) | Allowed |
| Editing files inside the project | Asks (or auto-approve per project) |
| Anything touching a path outside the project | Always asks, highlighted red, no "always allow" |
| Shell commands | Ask, unless they start with an allowed prefix; chained/redirected commands (`;`, `&&`, `\|`, `>`, `$(`) always ask |
| Web access, other MCP tools (e.g. `execute_luau`, `insert_asset`) | Ask |

Other protections:

- The API key is encrypted with the OS keychain (Electron `safeStorage`) and only passed to the Claude engine process — never to the UI or agent context.
- Only the project's own Claude settings are loaded (`settingSources: ['project']`), so global allow-rules in `~/.claude` can't widen permissions.
- Renderer is sandboxed with context isolation, no Node access, a strict CSP, blocked navigation and new windows, and IPC that only accepts calls from the app's own page. No local network ports are opened.
- Git runs with argument arrays (no shell), and file operations are checked to stay inside the project, including through symlinks.

Treat content agents read (Toolbox models, web pages, tool output) as untrusted — prompt injection is why risky actions require your click.

## Project layout

```
src/
  main/          Electron main process
    index.ts         window, security, IPC handlers
    agentRunner.ts   sessions, queues, concurrency, approvals (Agent SDK)
    permissions.ts   tool-use policy
    sdkMessages.ts   SDK stream → feed entries
    projects.ts      project registry, MCP config (Roblox Studio + .mcp.json)
    roles.ts         .claude/agents role files + templates
    git.ts, costs.ts, secrets.ts, pathScope.ts, jsonStore.ts
  preload/       the only bridge to the UI (window.hangar)
  renderer/      React UI
  shared/        types and IPC contract
tests/           node:test suites
```

App data (projects, settings, cost ledger, agent logs, encrypted key) lives in Electron's user-data folder.

## Known gaps / next steps

- **Not yet run end to end in Electron.** The code type-checks, the UI was rendered and inspected with mock data, and the core logic has unit tests, but the first real run with the SDK, Studio and a packaged build happens on your machine. Expect a small fix or two.
- **Packaged builds:** the SDK launches a native Claude Code binary; `asarUnpack` keeps it outside the archive, but verify a packaged build can start an agent before sharing it. Builds are unsigned until you add a code-signing certificate (Windows) and notarization (macOS).
- **Phase 5:** Roblox setup wizard (Rojo project scaffolding, `CLAUDE.md` template, install checks, Studio connection status).
- Later: auto-updates, a download website, per-agent cost charts.
