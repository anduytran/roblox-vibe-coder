# Hangar UI/UX overhaul and feature plan

Written by Claude Fable 5.1 on 2026-10-25 after reading every screen in `src/renderer` and the main-process code
behind them. Meant to be implemented by Claude Opus 5.5 one phase at a time, each phase its own commit, with
Dylan reviewing in the running app between phases.

**How to use this file:** pick the phases you want (or reorder them), then switch the session model to Opus 5.5
and say "Implement Phase 1 of docs/ux-overhaul-plan.md". Each phase lists the files it touches, what "done" looks
like, and the tests to add. Nothing in here loosens the safety rules in `SECURITY.md`; the rules that every phase
must keep are at the end.

---

## 1. The short version

Hangar's bones are right: a product-owner loop (brief → autopilot → check-in → feedback) with everything an agent
does fenced behind approvals and reviews. The UI has grown feature by feature, and three things now get in the way:

1. **Home does three jobs.** "What needs me", "my games", and a research desk (trending charts, ideas, Brainstorm,
   Saved, Refine) share one page. The ideas tools, which got five features this week, live in a 300-pixel column.
2. **Things that need you are scattered.** Approvals sit at the bottom of an agent's feed, reviews are in a project
   tab, check-ins on the Overview, and the only roll-up is the Home list (gone once you open a project).
3. **The check-in, the one artifact the product owner acts on, is a wall of `<pre>` text.** Questions aren't
   answerable one by one, "how to try it" isn't a button, and the design vault the Lead keeps is invisible in-app.

The plan, in priority order:

| Phase | What changes | Size |
|---|---|---|
| 1 | Shared building blocks: in-app confirm dialog, one diff viewer, safe text renderer, empty-state component | Small |
| 2 | Information architecture: **Ideas** becomes its own page, **Home** becomes the product-owner cockpit, an app-wide **Inbox** panel | Medium |
| 3 | Product-owner loop: structured check-ins with answerable questions, **Design** tab that renders the vault, desktop notifications | Medium |
| 4 | Reviews and Agents polish: per-file diffs, pinned approvals, grouped tool calls, review summary strip | Medium |
| 5 | Operations: spend over time, first-run checklist, keyboard shortcuts, project settings by category | Small–medium |
| Later | Headless playtests via Open Cloud, Studio connection probe, phone parity for Ideas and check-in answers | Needs decisions |

Phases 1–3 are the overhaul. Phases 4–5 are polish that can wait. Each phase works on its own; none depends on a
later one.

---

## 2. What I looked at and what I found

### Navigation and structure

- **Sidebar:** Home, New game, Games list (dots and badges for working/waiting/error), Open existing folder,
  spend or plan meters, Settings, Stop all agents. Good. Missing: a global count of what's waiting, and a way to
  reach Ideas without going "Home → scroll".
- **Project tabs:** Overview · Agents · 3D · Reviews · Changes · Settings. Two "Settings" (sidebar = app, tab =
  project) read as the same thing. **3D** is a single feature promoted to a tab. **Changes** is a git working-tree
  view that only matters when a project is *not* autonomous (in autonomous mode every change arrives as a review).
- **Home** (`Dashboard.tsx`, 368 lines): Needs you → Your games → What's trending (two-column: ideas tools left,
  trending table right). The ideas column holds a tab strip (Ideas/Saved), a Brainstorm button, a kind picker, a
  generate button, the cards, and the game-spaces list. It's cramped and the trending table steals the width.

### The product-owner loop

- **Overview** is really the Autopilot page: status pill, sprint meter, task list, "Steer the Lead", the check-in
  as `<pre>`, earlier check-ins as `<details>`. The check-in prompt already asks for four sections (`## Built`,
  `## Try it`, `## Next sprint`, `## Questions for you`) but the UI doesn't use that structure.
- **Feedback** is one textarea for everything (answers + direction). Questions can't be answered individually,
  and nothing records which answer went with which question.
- **"Try it"** is text; the actual actions ("Try it in Studio" = checkout, "Publish to test place") live on each
  review, not on the check-in.
- The Lead's **design vault** (overview, mechanics, roadmap, decisions) is the living spec, but you can only read
  it by opening Obsidian.

### Agents

- The feed is a flat list of entries (user, assistant, tool_use, tool_result, system, error, result). Tool calls
  and their results are separate entries; long results truncate with "Show more". It's readable but noisy.
- Approval cards render *inside* the feed, at the end. If the feed is long, the thing that needs you is below the
  fold and competes with scrolling.
- Role cards on the left are good (status, activity, queue, cost).

### Reviews and Changes

- Both render a raw unified diff line by line (`ReviewsView.tsx` and `ChangesView.tsx` have the same ~20 lines).
  No per-file sections, no collapse, no +/− counts, no jump list. Reviews with many files are a long scroll.
- Review detail order: incomplete/note bars → clip → checks → reviewer → agent's report → actions → diff. The
  report (what was built, how it was tested) is what you read first, and it's fourth.
- The list already has good badges (checks, reviewer verdict).

### Settings

- App Settings got categories this week (General, Account, Agents, Usage & limits, Roblox, Phone, Privacy).
  Project Settings is still one long page of nine cards (General, Tools, Autonomous, Checks, Sandbox,
  Permissions, Spending, Vaults, Test place, Remove).

### Small things that add up

- Seven native `confirm()` dialogs (discard review, merge anyway, turn autopilot off, revert file, remove project…).
  They look like the OS, not Hangar, and can't show formatted warnings.
- Empty states are ad hoc: some are a `<p className="small muted">`, some a `.empty` block with a heading.
- No loading skeletons; lists pop in (the new stagger animation helps).
- Dev-only console logging, crash boundaries and animations were added this week and should stay.

### What's already good and should not be redesigned

- The approval card (full summary never clipped, red for high-risk, "always" only when safe).
- Role editor, Research review (pages opened vs cited), checks and reviewer panels.
- New game wizard (three steps, summary, tool detection).
- The design tokens in `styles.css` (surface/raised/line/text-2/muted, amber/live/err/info, radii, type scale)
  and the light/dark handling. The overhaul reuses them; no new palette.

---

## 3. Design principles for the overhaul

1. **One job per screen.** Home = what needs you and how each game is doing. Ideas = finding and shaping the next
   game. Project = building this game.
2. **Things that need you are never below the fold.** Pinned, counted, one click away from anywhere.
3. **Agent-written text is data.** Render it as text or safe markdown; never HTML; strip hidden characters; links
   open only through the existing "Open in browser?" prompt.
4. **Keep Hangar's own look.** Dialogs, empty states and confirmations use the app's tokens, not the OS.
5. **Phone-readable.** Summaries at the top of every card; details collapse.

---

## 4. Phases

### Phase 1 — Shared building blocks (small, no behaviour change)

Create four components and use them everywhere they apply. This phase is almost pure refactor and makes the later
phases shorter and safer.

**New files**

- `src/renderer/src/components/ConfirmDialog.tsx` + a `confirmDialog({ title, body, confirmLabel, tone })`
  helper in `store.ts` that returns a promise. Replaces every `confirm()` in `ReviewsView`, `OverviewView`,
  `ChangesView`, `ProjectSettingsView`, `IdeaChat` (Start over has none yet; add one). Supports a list of warning
  lines (for "Merge anyway…").
- `src/renderer/src/components/DiffView.tsx`: takes a unified diff string, splits it into files, renders each
  file as a collapsible section with a header (path, +added/−removed), and a small file list at the top that
  scrolls to a file. Keeps the existing `d-add/d-del/d-hunk/d-meta/d-ctx` classes so the CSS carries over.
  Used by `ReviewsView` and `ChangesView`. Large diffs (> 4000 lines): collapse every file by default and show
  counts.
- `src/renderer/src/components/SafeText.tsx`: renders untrusted text (agent reports, check-ins, idea text,
  vault notes) as a minimal markdown subset: headings, paragraphs, bullet/numbered lists, bold, inline code,
  fenced code blocks. **No raw HTML, no images, no tables.** URLs become plain text with an "open" button that
  goes through `shell.openExternal`'s existing confirm prompt (via a new tiny IPC `system.openUrl(url)` that only
  accepts `https:` URLs without credentials; the main process already enforces this in
  `setWindowOpenHandler`, reuse that check). Strip `DECEPTIVE_CHARS` before rendering (export the regex from
  `src/shared` so the renderer can use it, or strip in main before sending; main-side is simpler: do it where
  reports and vault text are produced).
- `src/renderer/src/components/EmptyState.tsx`: icon, title, one line, optional action button. Replace the ad
  hoc empty blocks (Reviews, Changes, Agents feed, Models list, Ideas, Saved).

**Also**

- Rename the project tab "Settings" → **"Project"** (gear icon stays). The sidebar "Settings" stays.
- `src/renderer/src/components/ui.tsx`: add `Skeleton` (a shimmering bar) for lists that load (reviews diff,
  models list, trends table).

**Done when:** no `confirm(` left in the renderer; both diff views use `DiffView`; the agent report and check-in
text render through `SafeText`; typecheck and tests pass; `tests/renderer.test.ts` gains a check that no
component file contains `dangerouslySetInnerHTML` or `confirm(`.

---

### Phase 2 — Information architecture (medium)

**2a. Ideas becomes its own page**

- Sidebar gets **Ideas** (lightbulb icon) between Home and New game. Route state: `selectedProjectId === null`
  and a new `page: 'home' | 'ideas'` in the store.
- `src/renderer/src/components/IdeasPage.tsx` (move the ideas half of `Dashboard.tsx` here):
  - Top bar: kind picker as segmented chips (not a `<select>`), **Generate** / **New ideas**, **Brainstorm**.
  - Main area: a responsive card grid (2–3 columns) for Ideas; a **Saved** tab; a **Trending** tab holding the
    trending table and game spaces (moved from Home).
  - Brainstorm opens as a right-hand side panel (not a modal) so you can chat while looking at the cards; the
    refine screen stays a modal.
  - A **Compare** action: select two or three ideas → side-by-side table (pitch, loop, space, saturation, scope,
    score). Pure UI over existing data.
- Home's "What's trending" section becomes a one-line teaser card: "3 saved ideas · top space: Runner (Open) ·
  Open Ideas".

**2b. Home becomes the product-owner cockpit**

- Keep **Needs you** (now also lists pending *approvals by agent*, pending *reviews by title*, and check-ins; each
  row deep-links to the right tab, not just the project).
- **Your games** cards gain: last check-in's first line, time since last activity, and the three buttons that
  matter (Open · Reviews (n) · Start sprint / Resume).
- **This week**: one card with spend (or plan usage on Max), tasks merged, check-ins answered — from the cost
  ledger (`costs.json` entries) and review history. Numbers only, no chart yet (Phase 5).

**2c. Inbox panel (app-wide)**

- A bell button in the sidebar footer with a count; opens a slide-over panel (`InboxPanel.tsx`) listing every
  pending approval, review and check-in across projects, newest first. Approval cards render inside it (reuse
  `ApprovalCard`), reviews show title + badges + "Open", check-ins show sprint + "Answer".
- Also reachable with `Cmd/Ctrl+I`. Closes with Esc. The panel is the one place that is never below the fold.

**Done when:** Home has no trending table; Ideas page has Ideas/Saved/Trending; the Inbox count equals the sum of
pending approvals + pending reviews + check-ins; approving from the Inbox works; no feature was lost (every button
on the old Home exists somewhere).

---

### Phase 3 — The product-owner loop (medium)

**3a. Structured check-ins**

- `src/main/autopilot.ts` already asks for `## Built / ## Try it / ## Next sprint / ## Questions for you`. Add a
  parser (`src/shared/checkin.ts`, pure function, unit-tested) that splits the report into those four parts and
  turns "Questions for you" into a list. Store the parsed form on `SprintReport` (`sections`, `questions:
  string[]`) next to the raw `text` (keep `text` for old reports and as the fallback when parsing fails).
- Overview check-in card becomes four blocks: **Built** (SafeText), **Try it** (SafeText + the two actions:
  "Try it in Studio" → checkout the sprint's last merged state is not a thing, so link to Reviews filtered to this
  sprint, and "Publish to test place" when configured), **Next sprint** (an ordered list you can reorder/remove
  before starting; the reordered list is sent as part of the feedback), **Questions** (one answer box per
  question).
- "Start sprint N+1" sends feedback as: answers paired with their questions, then the (possibly edited) plan,
  then free-text direction. Format it in the renderer into the single `feedback` string the backend already takes
  (`Q: … / A: …` lines), so no IPC change.
- Keep a **Decisions** trail: the paired answers are appended to the report object (`answers`) so earlier
  check-ins show what was decided.

**3b. Design tab (read-only vault viewer)**

- New project tab **Design** (book icon) between Overview and Agents. Lists the markdown files of the Lead's
  vault (`design-vault/`, from `VaultsCard`'s existing knowledge of which role has which vault) and renders the
  selected one with `SafeText`. Order: `Roadmap.md`, `Game Overview.md`, then the `Mechanics/` folder's notes,
  `Balance.md`, `Decisions.md`, `Inbox.md`, then anything else (the templates are in `src/main/vault.ts`).
- Backend: `vault.list(projectId, vault)` and `vault.read(projectId, vault, file)` IPC. Listing covers `*.md`
  in the vault folder and one level of subfolders, uses `lstat` and skips links (like `models.ts`), never enters
  `.obsidian/`. Reading only accepts a path the listing returned, refuses links (`linkInPath`), caps at 200 KB.
- "Open in Obsidian" button stays (already exists in Project settings → Vaults).

**3c. Desktop notifications**

- Main process: when an approval, a review or a check-in becomes pending and the window is not focused, show an
  Electron `Notification` (main-process API; the renderer's permission handler keeps denying everything). Title
  "Sky Courier needs you", body one line, click focuses the window and opens the Inbox.
- Setting in App Settings → General: Notifications on/off (default on). Never include command text, paths or
  keys in a notification body — titles and counts only.

**Done when:** a sprint check-in renders as four blocks with per-question answers; answers appear in "Earlier
check-ins"; the Design tab shows the roadmap of a scaffolded project; a notification appears when a review lands
while the window is in the background; `tests/` cover the check-in parser and the vault reader's path rules.

---

### Phase 4 — Reviews and Agents polish (medium)

- **Review summary strip** at the top of a review: verdict chips (checks, reviewer, warnings), files changed,
  +/−, clip present, cost. Actions (Merge / Discard / Try it / Publish) stay in the header but become sticky.
- **Reorder** the review body: report → clip → checks → reviewer → diff (per-file, collapsible, from Phase 1).
- **Agents feed:** group a `tool_use` with its `tool_result` into one collapsible row ("Read src/… · 1.2 KB"),
  show consecutive tool rows as a compact run ("5 tool calls" expandable), keep assistant text full width.
  Keep the raw entries available (a "Show raw" toggle) — the raw feed is what SECURITY.md relies on for
  readability of approvals, and approvals are untouched.
- **Pinned approvals:** approvals render in a fixed strip above the composer, not inside the scrolling feed. The
  feed keeps a marker line where the approval happened.
- **Queue** shows as chips under the composer with remove-one (today: clear all only; add `agents.removeQueued`
  IPC, small).

**Done when:** a review with 30 files is navigable without scrolling the diff; an approval is visible without
scrolling in a 2,000-entry feed; raw feed toggle works.

---

### Phase 5 — Operations (small–medium)

- **Spend over time:** Project → Project tab and Home "This week": last 14 days as simple bars (CSS, no chart
  library; one color, the app's tokens), per project and per agent. Data from `CostTracker` entries (60 days kept).
  Add `costs.history(days)` IPC returning daily totals; no new storage.
- **First-run checklist** on Home when there are no projects: 1) Sign in (API key or Max) 2) Roblox Studio tools
  found (checks the Studio MCP command path exists; shows the exact Studio menu path if not) 3) Build tools found
  (rojo/selene/stylua/git, reuse `system.tools()`) 4) Create your first game. Each row has its action.
- **Keyboard shortcuts:** `Cmd/Ctrl+1…6` project tabs, `Cmd/Ctrl+K` project switcher (a small palette listing
  games and pages), `Cmd/Ctrl+I` Inbox, `Cmd/Ctrl+,` Settings, `Esc` closes panels. A "?" button lists them.
- **Project settings by category:** reuse the `settings-layout` nav from App Settings: General, Agents & tools,
  Autonomy & reviews (Autonomous, Checks), Safety (Sandbox, Permissions), Spending, Vaults, Test place, Remove.

**Done when:** the shortcuts work on macOS and Windows; the first-run checklist disappears after the first game;
project settings keep one window size across categories like App Settings does.

---

### Later — needs a decision before building

- **Headless playtests (CLAUDE.md open question):** run Luau against the test place through Open Cloud so
  autopilot can verify work without Studio open. Big: new credentials scope, new review check type, cost. Decide
  whether the test place + Rojo build + "Publish to test place" flow is enough for now.
- **Studio connection status** in the project header (green/grey dot). Needs a probe that starts Studio's MCP
  server and lists tools; Studio must be open. Medium, and the failure modes are murky; wait until the Studio
  modeler has been used for real.
- **Phone parity:** Ideas (read-only list + save), answering check-in questions, Inbox. The phone app is plain JS
  served by `remote.ts`; each feature is a separate small job after Phase 3 lands.
- **Download/auto-update/signing** (README "Later"): unrelated to UI; keep on the list.

---

## 5. Rules every phase must keep (from SECURITY.md and CLAUDE.md)

1. **Untrusted text stays text.** Reports, check-ins, vault notes, idea text, Roblox names/descriptions, tool
   results: render with `SafeText` or as plain text. No `dangerouslySetInnerHTML`, no markdown library that emits
   HTML, no images from untrusted sources, no auto-following links. Strip `DECEPTIVE_CHARS`.
2. **No new path from the renderer to the filesystem without the existing checks.** Any new IPC that names a file
   goes through `isInsideRoot` / `linkInPath` and a listing the main process made itself (see `models.ts` and
   `modelsReveal` for the pattern). Vault reading never touches `.obsidian/`.
3. **Approvals keep their shape.** Full summary always visible, red for high-risk, "Always allow" only when the
   policy says so, and the phone still can't approve high-risk actions. Moving approval cards (Inbox, pinned strip)
   must reuse `ApprovalCard` unchanged.
4. **Nothing new listens on the network.** Notifications are local; the Inbox is UI over existing IPC.
5. **No new dependencies** unless Dylan agrees first (the dependency audit is at 0 vulnerabilities; the renderer
   has no third-party code beyond React). Markdown rendering, diff splitting and charts are written by hand.
6. **Max mode, the key proxy, `settingSources: []`, the minimal agent env, git safety and the sandbox are not
   touched by any phase.**
7. **Every phase:** `npm run typecheck`, `npm test` (add tests for new pure logic: check-in parser, diff splitter,
   vault path rules, notification throttling), `npm run build`, then a commit authored as Dylan with no trailers.
   Restart `npm run dev` after main-process changes.

---

## 6. Open questions for Dylan

1. **Ideas as its own page** (Phase 2a) or keep ideas on Home in a wider layout? The plan assumes its own page.
2. **Inbox as a slide-over panel** or as a top-level page in the sidebar? Panel keeps your place; page is simpler.
3. **Design tab name:** "Design" or "Plan"? The vault is game design (overview, mechanics, roadmap, decisions).
4. Notifications: on by default?
5. Anything in "Later" you'd rather pull forward?
