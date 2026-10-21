# Hangar — notes for Claude Code

Hangar is an Electron desktop app (macOS + Windows) that runs Claude Agent SDK agents on Roblox game
projects. The owner, Dylan, uses it as a product owner: describe a game, agents build it in sprints,
he checks in. Personal use first; later a downloadable subscription product.

Read `README.md` (features, flow) and `SECURITY.md` (threat model, every audit finding) before changing
anything security-related.

## Working preferences
- Commits: authored as Dylan. **No `Co-Authored-By: Claude` or session-link trailers.**
- Plain-language explanations; he reviews from a phone sometimes, so keep summaries short.
- Ask before anything destructive or hard to undo (force-push, deleting branches/files, rewriting history).
- Repo: github.com/anduytran/roblox-vibe-coder, branch `master`.

## Status (as of 2026-10-20)
- Code complete for: per-project agents and roles, approvals, autonomous mode (branch per task,
  reviews), checks + read-only reviewer agent, web Researcher (findings reviewed before use),
  Obsidian vaults (UI + game design), phone remote over Tailscale, test-place publishing, playtest
  clips, New game wizard + scaffolding, autopilot sprints with check-ins, Home dashboard with trending
  Roblox games scored by demand × (1 − 0.4 × saturation), light/dark UI.
- 113 unit tests pass (`npm test`), typecheck clean (`npm run typecheck`).
- **Never run end to end yet.** It was built and tested in a sandbox with stand-ins for Electron,
  the SDK and Studio. The first real `npm run dev` happens on this Mac. Expect small fixes.
- `npm install` works; `npm audit --omit=dev` = 0. Electron was bumped to 44.9.2 and
  electron-builder to 26.15.3 to clear audit findings (untested on these versions yet).
  Remaining audit noise: `sprintf-js` (moderate, build tooling only).

## Next steps
1. `npm run dev` — get the app to launch on Electron 44; fix any errors.
2. Commit `package-lock.json` once it launches.
3. First-run checks from SECURITY.md ("Verify on first real run"), especially: in a sandboxed project,
   an agent running `touch ~/hangar-probe` must fail. Also confirm the SDK honours the `env` option,
   `PostToolUse` hooks fire, subagent tool calls hit `canUseTool`, and the researcher's `HTTPS_PROXY`
   with credentials works.
4. Try the flow on a throwaway game: New game → autopilot with auto-merge OFF at first.
5. Open questions: whether to build headless testing (Open Cloud Luau execution against the test
   place) so autopilot can verify work without Studio open; tune saturation weight and labels on real
   trend data.

## Layout
- `src/main` — Electron main process. Key files: `agentRunner.ts` (runs agents, approvals, research
  mode), `permissions.ts` + `pathScope.ts` (tool policy), `sandbox.ts`, `git.ts`, `autopilot.ts`,
  `scaffold.ts` (new game), `trending.ts` (Roblox charts + scores + ideas), `checks.ts`,
  `taskReviewer.ts`, `reviewPipeline.ts`, `reviewActions.ts`, `remote.ts` + `phoneApp.ts` (phone),
  `keyProxy.ts`, `webEgress.ts`.
- `src/renderer` — React UI (`components/`), design tokens in `styles.css`.
- `src/shared` — types and IPC contract. `tests/` — node:test suites.

## Rules that keep it safe (don't weaken without reason)
- No settings files are loaded by agents (`settingSources: []`); agents get a minimal env; the real
  API key is hidden behind the local proxy whenever commands can run without a click.
- Protected paths always ask in red; autopilot never auto-merges changes to tool/config files.
- Git only runs when the repo top folder is exactly the project; forced hooksPath can never exist.
- Any new feature that reads untrusted content (web, Roblox data, repo files) treats it as data,
  strips hidden characters, and never gives that reader write or network tools.
