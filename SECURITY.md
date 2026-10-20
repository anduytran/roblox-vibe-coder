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

## Remaining risks (be aware)

- **On Windows there is no OS sandbox.** An approved shell command runs with your full permissions. Read commands before allowing them.
- **You are the last line of defence.** Anything you approve runs with your permissions. Read red cards carefully; when unsure, deny. Turning on "auto-approve edits" means an agent can change your game code without asking (protected files still ask), so review the Changes tab before committing.
- **Prompt injection can still steer what agents write.** A malicious `CLAUDE.md` or role file in a cloned repo can influence agent behaviour (not run programs). Check those files in projects you didn't create.
- **The key-hiding proxy limits theft, not use.** While a run is active, a command it runs could use that run's token to make extra API calls (up to the per-run request cap) that Hangar doesn't count toward spending limits. The token stops working when the run ends. Use a dedicated API key with a spending limit in the Claude Console. If agents can't connect with hiding on, you can turn it off in Settings (the key is then visible to the engine).
- **One local port.** The proxy listens on 127.0.0.1 only and requires a per-run random token.
- **Same-user programs can decrypt the stored key.** OS keychain encryption (DPAPI on Windows) protects against other users and stolen disks, not against programs running as you — including commands you approve. Another reason to use a dedicated, spend-limited key.
- **Approved git config.** If you approve a repository whose git config defines filters, git commands that agents run (and you approve) will use them. Hangar itself still refuses to run git there.
- **Logs on disk.** Agent feeds (`agents.json` in the app data folder) and engine transcripts may contain code and command output in plain text.
- **Not yet run end to end.** These protections are unit-tested, but the first run with the real SDK, Studio and a packaged build happens on your machine. Builds are unsigned, Electron fuses are not yet set, and there is no committed lockfile until the first `npm install`.

## Reporting

This is a personal project. If you find a problem, open an issue in the repository.
