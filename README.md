# Hangar

A desktop control room for Claude-powered game development. Each project folder (for example a Rojo repo) gets its own team of agents — a general **Main** agent plus any roles you define (Lead, Scripter, UI Builder, QA Tester…) — running on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), with Roblox Studio connected through its built-in MCP server.

Built for personal use first; packaging for a downloadable installer is set up but not yet signed.

## How it works: you're the product owner

1. **New game** — describe the idea in a prompt or attach a design document, pick the platforms, model, budgets and how big each sprint is.
2. Hangar creates a ready-to-build Rojo project (code layout, lint/format config, `CLAUDE.md` conventions, starter roles, a game design vault with your brief, a first git commit) and turns on autonomous mode.
3. **Autopilot** takes over: the Lead writes the game overview, a roadmap with milestones and acceptance criteria, then builds one reviewed feature at a time.
4. Work that passes the checks and gets the reviewer agent's approval merges by itself; anything else waits for you. At the end of each sprint the Lead writes a **check-in**: what was built, how to try it, the plan for the next sprint, and questions for you.
5. You check in (desktop or phone), answer, give feedback, and start the next sprint. Repeat until it's the game you want.

**Home** shows what needs you, every game's sprint progress, and what's trending on Roblox with original game ideas, sorted by trending score.

## Home: trending games and ideas

Hangar reads Roblox's public discovery charts (Top Trending, Up-and-Coming, Top Playing Now) and the public details of those experiences, and keeps a snapshot each time so it can measure growth.

- **Demand** (0–100): momentum 30% (player growth over about a day; Up-and-Coming position until there's history), chart placement 25%, freshness 15% (newer experiences score higher), like ratio 15%, current players 15% (log scale).
- **Saturation** (0–100) of each game space (Roblox sub-genre): how many charting games are in it (50%), how much of its players the biggest game holds (30%), and how established the top games are (20%).
- **Trending score** = demand × (1 − 0.4 × saturation). A rising game in an open space ranks above an equally hot one in a space full of entrenched competitors. Spaces are labelled Open, Competitive or Crowded.
- **Ideas for you**: Claude (with no tools) suggests original concepts that ride what's trending, preferring open spaces, scored the same way. "Create this game" or "Use idea" opens the New game wizard pre-filled.

Saturation is measured among charting games, so it reflects competition among successful experiences rather than every game ever published.

## Autopilot details

- Sprints end after the chosen number of tasks or the sprint budget, whichever comes first.
- Auto-merge needs: checks passed (if configured), the reviewer agent's approval, no warnings or notes, and no changes to files that control how code or tools run (those always wait for you).
- Two failed tasks in a row, a stopped task, or closing Hangar pauses autopilot; Resume carries on. "Stop all agents" pauses every autopilot.
- "Steer the Lead" notes are handed to the Lead at the start of its next task; check-in feedback starts the next sprint.
- The phone app answers check-ins the way the desktop does (reorder or trim the plan, one answer per question, notes), starts the next sprint, pauses and takes notes.

## What it does

- **Projects sidebar** — one entry per folder, with live dots for working agents and a badge when something needs your approval.
- **Agent board** — every agent's status (idle, queued, working, needs approval, error), current activity, queue and session cost.
- **Live feed and chat** — messages, tool calls, results and errors as they happen. Sending while an agent is busy queues the task.
- **Roles as files** — roles are `.claude/agents/<id>.md` in the project, the same format Claude Code uses, so they're versioned with your game. "Add starter roles" creates four templates.
- **Approvals** — anything that changes things asks first (see *Safety model*). "Always allow" is saved per project and can be removed in the Project tab. **Explain** on a card asks a second AI, with no tools, what the action does and whether it looks safe, next to Hangar's own checks; it's advice only and never approves anything.
- **Changes tab** — git diff of everything agents changed, commit all, or revert a single file (new files go to the OS trash, never hard-deleted).
- **Files tab** — browse the game's folder read-only: CLAUDE.md, role files, the Rojo project and source, with uncommitted changes marked. Markdown can be shown formatted. Links and `.git` are never shown, nothing is ever opened or run from here, and *Show in Finder* only reveals.
- **GitHub** — link a project to a GitHub repository (Project → GitHub) and Push or Pull its current branch, or *Clone from GitHub* in the sidebar to start from one. Only you push or pull, never agents; task branches are never pushed, pushes are never forced, and pulls only fast-forward. Git signs in the way it does in your terminal (for example after `gh auth login`).
- **Spending controls** — per-task limit, daily limit across projects, optional daily limit per project, and a **Stop all agents** button.
- **Light and dark themes** — follows your OS, or pick one in Settings → Appearance.
- **Sessions resume** — each agent continues its conversation across tasks and app restarts until you click *New session*.

## Autonomous mode

Turn it on per project (Project tab → Autonomous mode). Agents then work without asking inside the fence — edits in the project, sandboxed shell commands, and Studio's playtest tools (start/stop play, simulated input, running test code) — and you review results instead of approving steps:

- Each task runs on its own git branch (`hangar/<agent>-<task>-<id>`) created from your current branch. When it finishes, Hangar commits the work to that branch (as "Hangar (<agent>)"), switches back, and the task appears in the **Reviews** tab with the agent's report, the diff, and a playtest clip if you asked for one.
- **Merge** squashes it into your branch as one commit; **Discard** deletes the branch; **Try it in Studio** switches your project folder to the branch so Rojo syncs it into Studio.
- Tasks in an autonomous project run one at a time (they share your folder and Studio). The project needs git with a first commit and no uncommitted changes when a task starts.
- Still asking (from your desktop or phone): anything outside the project, network access, protected files, Toolbox assets, Studio's web fetch and AI generation, and — on Windows, where there's no sandbox — shell commands.

## Before you merge: checks and the reviewer agent

Project tab → Before you merge. Every finished autonomous task is checked before it reaches you:

- **Checks** — commands you list (suggested: `stylua --check src`, `selene src`, `rojo build -o hangar-check.rbxl`) run in a temporary copy of the task's branch, so your project folder isn't touched. On macOS/Linux they run inside the OS sandbox. They're skipped (and Merge asks you to confirm) when a task changes files that decide what runs, like `rokit.toml`, `package.json` or JS tool configs.
- **Reviewer agent** — a separate, read-only Claude session reads the change with a Roblox checklist (client trust in RemoteEvents, backdoors like `require(id)`/`loadstring`, DataStore safety, performance, scope creep) and returns a verdict with findings. Up to $1 per task.

Results show on the review (desktop and phone). Merge turns into **Merge anyway…** when a check failed or didn't run, the reviewer says "don't merge", or something is still running. **Run again** / **Review again** re-run them.

## Web researcher

The **Researcher** role (in the starter roles) searches the web — Roblox docs, DevForum, APIs — and writes a sourced report. It's fenced off from everything else: only web search and reading public pages, no project files, commands, Studio or subagents, no other agent can call it, and it never keeps a session. Its report lands in **Reviews** with the list of pages it actually opened (recorded by Hangar) and the searches it ran. **Approve & save** writes it to `research/<date>-<topic>.md` in the project and commits just that file; from then on every agent can read it. Discard and nothing is kept. That's the point: web content, which can contain instructions aimed at AIs, only reaches your agents after you've read it. Any role can be made a researcher (Edit role → Kind).

## Obsidian vaults

Two roles keep an Obsidian vault in the project by default (any role can have one: Edit role → Obsidian vault folder and templates):

- **Lead → `design-vault/`** (game design): Game Overview (pitch, core loop, pillars), Mechanics with **acceptance criteria**, Content lists, Balance numbers, Roadmap, Decisions and an Inbox for feature ideas. The Lead plans to it, hands acceptance criteria to whoever builds a feature, checks them when it's done, and keeps the numbers in sync with the code.
- **UI Builder → `ui-vault/`**: Home, Style Guide, Screens, Components, Decisions and an Inbox for UI requests. It reads it before UI work and updates the notes after, so the vault stays a living spec of your game's interface.

Vaults are created from templates on first use (or Project tab → Obsidian vaults). Open it with Obsidian → "Open folder as vault", or from Project tab → Obsidian vaults. The vault lives in the project, so note changes are versioned and appear in reviews. Agents can never write the vault's `.obsidian/` folder (Obsidian plugins there run code).

## Phone remote

Settings → Phone remote. Hangar listens on `127.0.0.1` only; one command makes it reachable from your own Tailscale devices over HTTPS (never the public internet):

```bash
tailscale serve --bg --https=443 127.0.0.1:47621
```

Never use `tailscale funnel` for this (that would expose it to the internet). Open the shown `https://<computer>.<tailnet>.ts.net/` address on your phone, add it to your Home Screen, and pair it with the 6-digit code from "Pair a phone". From the phone you can see every project and agent, use an Inbox ordered like the desktop's, answer sprint check-ins, read ideas and what's trending (and save or unsave ideas), queue tasks (with "Record playtest"), approve or deny everyday actions, review/merge/discard finished tasks, publish them to your test place, and stop all agents. Generating or refining ideas costs money, so it stays on the computer. Turn on notifications in the phone app's Settings tab (on iPhone, open it from the Home Screen first). Settings, permission rules and high-risk approvals can only be changed on the computer.

## Playtest clips

Tick **Record playtest** when queueing a task. While the agent playtests, Hangar records only the Studio window (up to 30 s) and attaches the clip to the review:

- macOS: uses the built-in `screencapture`; grant Hangar Screen Recording and Accessibility permission when asked. Install `ffmpeg` (`brew install ffmpeg`) for smaller .mp4 files.
- Windows: needs `ffmpeg` (`winget install ffmpeg`).
- If recording isn't possible, the screenshots the agent takes during the playtest are shown as a slideshow instead.

Recording captures the Studio window's area of your screen, so anything overlapping it is captured too. Clips are stored in Hangar's data folder (never your project or git) and deleted when you merge or discard the task.

## Test place publishing

Project tab → Test place: enter the universe and place ID of a **private test place** (not your live game) and a Roblox Open Cloud API key created with only the `universe-places` Write permission for that game. On a review, **Publish to test place** builds that branch with Rojo in a temporary folder and uploads it; then open the place in the Roblox app on your phone. Agents can never publish — only your tap does.

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
| Web access | Asks every time (no "always allow"). The Researcher role searches and reads public pages freely, but has no other tools and its findings wait for your approval |
| Other MCP tools (e.g. `execute_luau`, `insert_asset`) | Ask |

**OS sandbox (macOS and Linux):** on by default, shell commands run inside the operating system's sandbox. They and anything they start can only write to the project folder and a temp folder, can't read your credential folders or Hangar's data, and have no network unless you list domains in the Project tab. If the sandbox can't start, nothing runs — there is no fallback to unsandboxed commands. Native Windows has no sandbox, so there approved commands run with your full permissions (the app says so).

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
    checks.ts        "before you merge" check commands (temp checkout, OS sandbox)
    taskReviewer.ts  read-only reviewer agent
    reviewPipeline.ts runs checks then the reviewer on each finished task
    webEgress.ts     the web researcher's filtering proxy
    vault.ts         Obsidian vault templates (UI, game design)
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
