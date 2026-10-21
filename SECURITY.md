# Hangar security notes

Hangar runs AI agents that can read files, edit code and run commands on your computer. No software like this can be 100% safe. This document says what Hangar defends against, what was found in audits and fixed, and what risk remains.

## Threat model

1. **A hijacked agent.** Agents read untrusted content: Roblox Toolbox models, web pages, files in a downloaded or cloned project, tool output. Any of it can contain instructions ("prompt injection"). Hangar assumes an agent may be fully hijacked and tries to ensure it still can't run programs, read secrets, leave the project folder or widen its own permissions without your click.
2. **An untrusted project folder.** A cloned repo or downloaded zip can ship config that runs programs: `.mcp.json`, `.claude/settings.json`, `.git/config`, git hooks, toolchain manifests.
3. **A compromised UI.** Agent output and file names are displayed in the window; they must not be able to reach the operating system.

Out of scope: malware already running as your user, and someone with physical access to your unlocked computer.

## Audit history

The code was audited by an independent reviewer (not the author) in three rounds on 2026-10-19, with fixes after each round. Each finding below has a regression test in `tests/` that reproduces the attack and checks it is blocked.

| Finding | Severity | Fix |
| --- | --- | --- |
| Default shell allowlist (`git log`, `git diff`) let an agent write `.git/config` or files anywhere via `--output=`, and print secret files | Critical | Shell rules match word-for-word; extra words only with a trailing ` *` rule and only plain relative file names. No flags, quotes, `$`, `~`, `%`, globs, chaining or redirection can ever be auto-allowed. Defaults reduced to `git status`, `selene`, `stylua --check`. |
| A project's `.mcp.json` launched any program on the first run, without asking | Critical | "Project setup" approval before any agent starts, showing exact commands and environment. Approval is tied to a hash of the server definitions, the scripts they run, and toolchain manifests; any change asks again. The reviewed definitions are what get launched. `Roblox_Studio` name reserved. |
| `settingSources: ['project']` loaded a repo's `.claude/settings.json`, whose hooks run commands and whose allow-rules skip approvals | Critical | `settingSources: []`. Hangar injects `CLAUDE.md` and roles itself. |
| Hangar's own `git status`/`diff`/`commit` obeyed repo config (`core.fsmonitor`, hooks, filters, textconv) | Critical | Forced config via `GIT_CONFIG_COUNT` (fsmonitor, hooks, pager, signing off) for Hangar and agents; `--no-ext-diff --no-textconv --no-verify`; Hangar refuses to run git if the repository's own config (any location, checked by scope) defines filters, textconv, external diff or similar. Fails closed. |
| Repo config in a parent folder was trusted when a subfolder was opened | High | Config is judged by git scope (local/worktree), not file location. |
| Edits to `.git/`, `.claude/`, `.mcp.json`, `CLAUDE.md`, CI and editor config were auto-approvable | High | Always ask in red, never "always allow", at any depth, case-insensitive. Windows tricks (trailing dots/spaces, `::$DATA` streams, `GIT~1` short names) are treated as outside the project. |
| API key and the whole environment reached agents | High | Agents get a minimal environment. By default the real key never reaches them: the engine talks to a local token-protected proxy that adds the key. Commands that look like they print secrets are flagged red. |
| "Always allow" saved a two-word prefix (`node -e` allowed any code) | High | Saves the exact command; refused for interpreters, shells, package managers, build tools, deleters and downloaders however spelled (`python3.12`, `node.exe`, paths). Whole-tool "always" only for Roblox Studio tools. Web access never. |
| Unpinned SDK dependency | High | SDK pinned to an exact version; `postinstall` script removed. |
| Glob/Grep patterns could search outside the project (incl. brace tricks) | Medium | Absolute, `..`, `~` and brace-smuggled patterns ask in red. |
| Spending limits could be overshot by parallel or stopped runs | Medium | Running agents reserve their per-task budget; stopped/crashed runs count the per-task limit; 80-turn cap; lower maximums. |
| Approval card could hide content (clipping, truncation, invisible/bidi characters) | Medium | Summary never clipped; truncation is labelled; hidden characters (zero-width, bidi, tags, controls) are flagged red and shown as `⟦U+XXXX⟧`. |
| Loose app-URL check for navigation and IPC | Medium | Exact URL match; redirects, webviews and frames blocked. |
| Edits to a module an approved MCP script imports re-ran without approval | Medium | The whole folder holding a server's script is hashed into the approval and protected from agent edits. |
| Editor config (`.cursor/`, `.devcontainer/`, `.zed/`, `.pre-commit-config.yaml`, mise files) unprotected | Medium | Added to protected files. |
| Glob syntax (`[.][.]/x`, nested braces) could hide `..` | Medium | Patterns are also checked with glob syntax stripped. |
| "Always allow" denylist missed `tsx`, `sed`, `awk`, Windows script hosts, risky git subcommands | Medium | Replaced with an allowlist of project tools and read-only utilities; flags that write files or run programs (`-o`, `--output`, `--pre`, `-c`…) are never saved. |
| The proxy token could reach batches/files endpoints and lived for the whole launch | Medium–High | One token per run, revoked when the run ends; only `POST /v1/messages` and `/count_tokens`; request cap per run; header allowlists both ways; size and time limits. |
| A project's `CLAUDE.md` and role files went to agents unreviewed | Low | Shown on the project's first approval. |

## OS sandbox

On macOS and Linux, agents' shell commands run inside Claude Code's built-in sandbox (Seatbelt on macOS, bubblewrap on Linux/WSL2), configured by Hangar per project:

- Writes only to the project folder and a temp folder; Hangar's protected files and the folders of approved MCP scripts are write-denied too.
- No reads of credential folders (`~/.ssh`, `~/.aws`, cloud CLIs, `~/.claude`) or Hangar's own data folder.
- No network except domains you list for the project.
- `failIfUnavailable` and `allowUnsandboxedCommands: false`: if the sandbox can't start the run fails, and the engine's "retry outside the sandbox" option is refused (Hangar also denies it directly).
- Sandboxed commands still ask for approval unless the project auto-approves edits.

The sandbox covers shell commands only. File edits are covered by Hangar's own path rules, and MCP servers (including Roblox Studio) run outside it. It is not available on native Windows.

## Autonomous mode, phone remote, publishing and clips (audited 2026-10-20)

These features were reviewed by an independent reviewer before release; each finding has a regression test.

| Finding | Severity | Fix |
| --- | --- | --- |
| An autonomous agent could move `main` (or other branches) to unreviewed commits, or trick Hangar into committing onto `main` | High | Agents' sandboxed commands can't write `.git` at all. Hangar snapshots every branch and tag when a task starts and puts back anything the agent changed; it refuses to commit unless it's on the task branch; reviews diff and merge the exact recorded commits, and a branch changed after review can't be merged. |
| "Publish to test place" could embed files from outside the project (Rojo `$path`, symlinks) or run a planted `rojo` binary | High | Branches with symlinks/submodules are refused; every `*.project.json` `$path` must be a plain relative path; Rojo is resolved from `PATH` once and run from Hangar's own folder; one publish at a time, never while an agent is working. |
| `execute_luau` (edit-mode Luau) was auto-allowed in autonomous mode, bypassing git review | Medium-High | Now asks; only play-mode testing and simulated input run freely. |
| Sandboxed auto-run commands skipped Hangar's protected-file and secret checks | Medium | Sandbox write-denies protected names at any depth (plus `.git`); autonomous runs always hide the API key; `.gitignore` edits are protected and flagged in reviews. |
| Phone approvals could hide content (truncation, raw input not shown) | Medium | The phone can only approve requests it shows in full and plain shell commands; full details are viewable; anything else must be approved on the computer. |
| Remote accepted any `*.ts.net` host before the tailnet name was known; Funnel not blocked | Low | Only this computer's own tailnet name; requests via Funnel are refused. |
| Clip frames accepted any tool's images without type/size checks; clip files leaked | Low | Only Studio screenshots, checked by file signature, max 5 MB each; clips deleted with reviews. |

Phone remote design: Hangar listens on `127.0.0.1` only and is exposed to your own Tailscale devices by `tailscale serve` (HTTPS). Pairing uses a 6-digit code (5 minutes, 5 tries); devices get random tokens stored only as hashes; every API call needs the token; Host and Origin are checked; the phone app runs under a strict CSP with no inline script. The phone can't change settings or rules, choose "always allow", or approve high-risk actions. Never expose Hangar with `tailscale funnel`.

## Checks, reviewer agent and web researcher (audited 2026-10-20)

Design:
- **Checks** run in a temporary checkout of the task's exact commit, inside Hangar's data folder, without a shell, with programs resolved from `PATH` (never the checkout), a minimal environment, `NoDefaultCurrentDirectoryInExePath=1` on Windows, a time limit, and — on macOS/Linux with the project's sandbox on — inside the OS sandbox (Seatbelt / bubblewrap: no network, writes only to the checkout and temp, no reading credential folders or Hangar's data). If the sandbox is wanted but missing, checks report an error instead of running unsandboxed.
- **Reviewer agent**: a separate session with only Read/Glob/Grep, every call checked by Hangar's path policy against the temporary checkout; no MCP servers, subagents, settings files, web or shell; always behind the key-hiding proxy; $1 cap. Its verdict is advice and never merges or blocks on its own.
- **Web researcher**: only WebSearch and WebFetch; runs in an empty temporary folder with no project files, `CLAUDE.md`, MCP servers or subagents; is never offered as a subagent; never resumes or keeps a session; always behind the key-hiding proxy. Pages must be public `http(s)` host names (no IPs, `localhost`, `.local`, tailnet names), and its web traffic goes through Hangar's egress proxy, which resolves names itself, refuses loopback/private/CGNAT/link-local/tailnet addresses and connects to the exact address it checked. Its report reaches other agents only after you approve it into `research/` (hidden characters stripped, the pages it opened recorded by Hangar).

| Finding | Severity | Fix |
| --- | --- | --- |
| On Windows a check could run a program the branch planted in the checkout (cmd.exe and Node find `node.bat` etc. in the current folder first) | High | `NoDefaultCurrentDirectoryInExePath=1`; checks are skipped when a task adds program or script files (`.exe`, `.bat`, `.cmd`, `.ps1`, …) or files named like the tools. |
| JS tool configs are code (`eslint.config.js`, `.prettierrc.cjs`, `tsconfig` plugins), so an agent could get code run by a check | High | Checks run inside the OS sandbox on macOS/Linux; checks are skipped when a task changes any such file. |
| An agent could avoid the failing-checks prompt by getting checks skipped | Medium | "Checks didn't run" is a merge warning. |
| `allowedTools` pre-approved the reviewer's reads, bypassing the path check | Medium | Removed; every read goes through Hangar's policy. |
| Text in the diff could turn a reviewer "block" into an error, which didn't warn | Medium-Low | A reviewer that didn't finish is a merge warning. |
| "Merge anyway" could skip a warning that appeared after you looked (e.g. a late "block") | Medium-Low | Merge anyway only covers the exact warnings you were shown; anything new is refused. |
| The researcher could reach local services through names that resolve to this computer; sessions could carry web content across runs | Low-Medium | Egress proxy with resolve-then-connect; research sessions are never resumed or saved. |
| `research/` or a vault folder that is a link could make Hangar write outside the project | Low | Both must be real folders inside the project. |

## Full re-audit (2026-10-20, two independent reviewers)

Agent execution, policy and git:

| Finding | Severity | Fix |
| --- | --- | --- |
| The forced "no hooks" folder was in temp and its path was visible to agents; an agent could create it, plant a hook, and Hangar's own git (unsandboxed) would run it | Critical | The hooks path can never exist (inside `/dev/null` on macOS/Linux; inside a regular file in Hangar's data folder on Windows). Hangar's git runs with a minimal environment. |
| Git-ignored files an autonomous task created or changed (`Packages/`, `node_modules/`, `.env`, build output) stayed in the project after switching back, never reviewed | High | Ignored files are fingerprinted when a task starts; anything new or changed is moved out to a quarantine folder and listed on the review. `node_modules` is protected and sandbox write-denied. |
| A repository whose config sets `core.worktree` (or a project inside a bigger repository) let `git add -A`/checkout reach files outside the project | High | Git only runs when the repository's top folder is exactly the project and its git data is inside it; `core.worktree`, credential helpers and `alternateRefsCommand` are flagged. |
| A link swapped in between Hangar's path check and the write could send an edit outside the project | Medium | Edits through any link ask in red; after every write Hangar re-checks the path and stops the run if it left the project. |
| A merge or checkout could interleave with a task starting in the same project | Medium-Low | Review actions hold the project; no task starts until they finish. |
| Assorted: sandbox denies narrower than the edit rules; auto-run Bash with key hiding off; more ways to print env vars; `node .` MCP servers not hashed; look-alike Studio server names; vault folders created through links | Low | Sandbox denies the same names at any depth; any auto-run mode forces key hiding; more secret patterns (also for PowerShell); `node .`/npm servers hash `package.json` and its main file, folder arguments hash the folder; names normalising to `Roblox_Studio` are dropped; vault paths are checked before anything is created. Hangar also removes credential-looking variables from its own environment at startup. |

Network, Electron and phone remote:

| Finding | Severity | Fix |
| --- | --- | --- |
| A paired phone could register an invalid push key that broke notifications for every phone and threw in the main process | Medium | Keys must be real curve points; sending never throws. |
| Helper programs (ffmpeg, PowerShell, tailscale) were started by name; on Windows that searches the current folder first | Medium | Absolute paths only; Hangar's working folder is its own data folder. |
| The researcher's egress proxy was an open tunnel for anything on the machine | Low-Medium | Per-run credentials that stop working when the run ends. |
| Lost phones stayed paired forever; pairing revealed when it was active; phone names could contain hidden characters | Low | Unused phones are unpaired after 30 days; uniform pairing answers; names cleaned. |
| Electron granted permission requests by default; links opened without saying where; dev websocket in the shipped CSP | Low | All permission requests refused; links show their host and ask; production CSP has no websocket. |

### Verify on first real run (SDK behaviour Hangar relies on)

**Verified 2026-10-20 on macOS** (Agent SDK 0.3.304, Claude Max mode) with `scripts/first-run-checks.ts`: all six pass.
Re-run it after SDK upgrades. `touch ~/hangar-probe` failed with "Operation not permitted"; the engine saw only Hangar's
minimal environment plus its own variables; a subagent's `Write` raised an approval card; the `PostToolUse` hook stopped
a write through a link; and the researcher's fetches (and its engine's API calls) went through the egress proxy.

These can't be tested without the real Agent SDK and are worth checking once:
- The SDK uses the `env` Hangar passes (not merged with the full environment). Hangar now strips credential variables from its own environment either way.
- The OS sandbox is really applied (`settings.sandbox`): with a sandboxed project, ask an agent to run `touch ~/hangar-probe` — it must fail.
- Subagent tool calls go through Hangar's approvals and count toward the per-task budget.
- `Read` of a file outside the project shows a red approval card.
- `PostToolUse` hooks run (the link check after writes).
- The researcher's web fetches use `HTTPS_PROXY` with credentials (otherwise its fetches fail; the host-name rules still apply).

## New game, autopilot and trends (2026-10-20)

- **Auto-merge** only applies work that passed every gate: checks (if configured), the reviewer agent's approval, no merge warnings, no notes (quarantined ignored files, edited `.gitignore`, history problems), and no changes to protected or tool-config files (`package.json`, CI/editor config, JS tool configs, scripts, `node_modules`, `.mcp.json`…). Everything else waits for you. Turn auto-merge off to review every task.
- **Trends** come from two fixed Roblox hosts (`apis.roblox.com`, `games.roblox.com`), read-only, no credentials, responses size-limited; names and descriptions are cleaned of hidden characters and treated as untrusted text.
- **Idea generation** runs Claude with no tools, no project, behind the key-hiding proxy; its output is shown to you and only becomes a brief if you click "Create this game" (you see it in the wizard first).
- **New projects** are created only inside a folder you choose, never into a non-empty folder; the game name is sanitised before it's written into code.
- **Phone**: a paired phone can start the next sprint, pause/resume and add notes (spending stays within the sprint, project and daily limits).

## Claude Max mode (personal use, development builds only)

- Agents can sign in with the owner's Claude subscription (`claude setup-token`) instead of an API key. Anthropic doesn't allow apps to offer claude.ai sign-in or to hold subscription credentials for other people, so this is for the owner's own use: packaged builds ignore the setting and refuse to store a token (`app.isPackaged`).
- The token is stored like the API key (OS keychain), but it is **not** hidden behind the key proxy — proxying it would mean Hangar intermediates subscription credentials. The engine gets it as `CLAUDE_CODE_OAUTH_TOKEN`, so in autonomous or auto-run projects, commands an agent runs might reach it. (On the 2026-10-20 check, shell commands did not inherit it, but it still sits in the engine process.) Each such run says so in its feed. The token lasts a year; revoke it at claude.ai if it leaks.
- Spending limits still apply, but to the SDK's estimated cost; the subscription's own usage limits apply on top.

## Remaining risks (be aware)

- **On Windows there is no OS sandbox.** An approved shell command runs with your full permissions. Read commands before allowing them.
- **You are the last line of defence.** Anything you approve runs with your permissions. Read red cards carefully; when unsure, deny. Turning on "auto-approve edits" means an agent can change your game code without asking (protected files still ask), so review the Changes tab before committing.
- **Prompt injection can still steer what agents write.** A malicious `CLAUDE.md` or role file in a cloned repo can influence agent behaviour (not run programs). Check those files in projects you didn't create.
- **The key-hiding proxy limits theft, not use.** While a run is active, a command it runs could use that run's token to make extra API calls (up to the per-run request cap) that Hangar doesn't count toward spending limits. The token stops working when the run ends. Use a dedicated API key with a spending limit in the Claude Console. If agents can't connect with hiding on, you can turn it off in Settings (the key is then visible to the engine).
- **One local port.** The proxy listens on 127.0.0.1 only and requires a per-run random token.
- **Same-user programs can decrypt the stored key.** OS keychain encryption (DPAPI on Windows) protects against other users and stolen disks, not against programs running as you — including commands you approve. Another reason to use a dedicated, spend-limited key.
- **Approved git config.** If you approve a repository whose git config defines filters, git commands that agents run (and you approve) will use them. Hangar itself still refuses to run git there.
- **Checks on Windows** run without an OS sandbox. Linters and Rojo only read code, but a test runner that executes game code (for example Lune) runs it with your permissions. Only add such checks if you're comfortable with that.
- **The reviewer agent can be fooled.** It reads code another agent wrote; treat "looks good" as a second opinion, not a guarantee.
- **Auto-merged work is still agent-written.** The reviewer agent can be fooled; auto-merge only lands game code (never tool or config files), but check in regularly and play the result. You can revert any merge with git.
- **Approved research is trusted context.** Once you approve a report, every agent may read it. Read it for accuracy and for instructions aimed at an AI before approving. Pages on documentation sites the engine trusts by default may be missing from the "pages it opened" list.
- **The researcher's egress proxy** relies on the engine honouring `HTTPS_PROXY` for web fetches; the host-name rules apply either way. If you use a corporate proxy, the researcher connects directly instead of through it.
- **Playtest recordings** capture the Studio window's area of the screen; anything overlapping it (a notification, another window) is captured too.
- **Logs on disk.** Agent feeds (`agents.json` in the app data folder) and engine transcripts may contain code and command output in plain text.
- **Not yet run end to end.** These protections are unit-tested, but the first run with the real SDK, Studio and a packaged build happens on your machine. Builds are unsigned, Electron fuses are not yet set, and there is no committed lockfile until the first `npm install`.

## Reporting

This is a personal project. If you find a problem, open an issue in the repository.
