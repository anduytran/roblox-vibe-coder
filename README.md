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

The Agent SDK version is pinned exactly. Commit `package-lock.json` after the first install, and use `npm ci` for builds.

## Safety model

Hangar assumes an agent can be tricked by what it reads (Toolbox models, web pages, files in a cloned repo) and tries to make sure that a tricked agent still can't do damage without your click. It was audited against that threat model; see `SECURITY.md`.

Every tool call that isn't clearly safe goes through Hangar's policy (`src/main/permissions.ts`):

| Action | Default |
| --- | --- |
| Reading/searching inside the project | Allowed |
| Read-only Roblox Studio tools (game tree, console output, screenshots) | Allowed (only for the Studio server Hangar itself connects) |
| Editing files inside the project | Asks (or auto-approve per project) |
| Editing `.git/`, `.claude/`, `.mcp.json`, `CLAUDE.md`, `.vscode/`, `.github/`, `package.json` | Always asks, in red, never "always allow" |
| Anything touching a path outside the project (including `~`, `$VAR`, `%VAR%`, network paths, outside Glob patterns) | Always asks, in red, never "always allow" |
| Shell commands | Ask, unless they match an allow rule exactly (a rule ending in ` *` also allows plain relative file names after it). Flags, quotes, variables, `~`, globs, chaining and redirection are never auto-allowed. Defaults: `git status`, `selene *`, `stylua --check *` |
| Commands that could print secrets (`env`, `printenv`, `$ANTHROPIC_API_KEY`, …) | Always ask, in red |
| Web access | Asks every time (no "always allow") |
| Other MCP tools (e.g. `execute_luau`, `insert_asset`) | Ask |

**OS sandbox (macOS and Linux):** on by default, shell commands run inside the operating system's sandbox. They and anything they start can only write to the project folder and a temp folder, can't read your credential folders or Hangar's data, and have no network unless you list domains in Project settings. If the sandbox can't start, nothing runs — there is no fallback to unsandboxed commands. Native Windows has no sandbox, so there approved commands run with your full permissions (the app says so).

Before any agent starts in a project, programs the folder would launch — MCP servers in `.mcp.json`, or repository git config that runs commands — are shown for approval. Any change to them asks again.

Other protections:

- No Claude settings files are loaded (`settingSources: []`): not your global ones, and not a repository's `.claude/settings.json`, whose hooks or allow-rules could otherwise run commands or skip approvals. Hangar adds `CLAUDE.md` and the roles itself.
- Agents get a minimal environment (PATH, home and temp folders, locale) plus the API key; other tokens in your environment never reach them.
- Every git process (Hangar's and the agents') runs with fsmonitor, hooks, pagers and commit signing forced off. Hangar refuses to run git at all in a repo whose config defines filters, textconv, external diff or similar.
- The API key is encrypted with the OS keychain and never sent to the UI. By default agents never see it: each run gets a short-lived token for a local proxy that adds the real key (Settings → Hide API key from agents). Use a dedicated key with a spending limit set in the Claude Console.
- Running agents reserve their per-task budget against the daily limit, so parallel runs can't overshoot it. Runs are capped at 80 turns.
- Renderer is sandboxed with context isolation, no Node access, a strict CSP, blocked navigation, redirects, webviews and new windows, and IPC that only accepts calls from the app's exact page. No local network ports are opened.

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
