import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per-project Obsidian vaults for roles (the UI Builder by default): a folder of plain Markdown notes
 * inside the project — style guide, screens, components, decisions, an inbox of requests — that the
 * agent reads before working and keeps up to date, and that you read and edit in Obsidian.
 *
 * It lives inside the project folder so it's versioned with the game, reachable inside the sandbox,
 * and every note change shows up in reviews. Hangar never creates `.obsidian/` (Obsidian makes it when
 * you open the vault) and agents can't write there: Obsidian plugins in that folder run code.
 */
const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}(\/[A-Za-z0-9][A-Za-z0-9 _-]{0,40}){0,2}$/

export function validVaultFolder(folder: string): boolean {
  return SAFE_FOLDER.test(folder) && !folder.split('/').some((s) => s.startsWith('.'))
}

const today = (): string => new Date().toISOString().slice(0, 10)

const TEMPLATES: Record<string, () => string> = {
  'Home.md': () => `---
tags: [hangar, ui]
---
# UI vault

The knowledge base for this game's interface. The UI Builder agent reads these notes before UI work and updates them after; you can edit anything here in Obsidian.

- [[Style Guide]] — colours, fonts, spacing, layout rules
- [[Screens/_Index|Screens]] — every screen and HUD element
- [[Components/_Index|Components]] — reusable pieces (buttons, cards, bars)
- [[Decisions]] — why things are the way they are
- [[Inbox]] — requests and ideas for the UI Builder

Created by Hangar on ${today()}.
`,
  'Style Guide.md': () => `---
tags: [ui, style]
---
# Style Guide

> Fill this in (or ask the UI Builder to draft it from the existing UI). Agents follow it.

## Colours
| Name | Hex | Used for |
| --- | --- | --- |
| Background | #0F1115 | Panels |
| Accent | #F5A524 | Primary buttons, highlights |
| Text | #E8EAF1 | Body text |
| Danger | #FF6B6B | Warnings, damage |

## Typography
- Headings: BuilderSans Bold
- Body: BuilderSans Medium
- Minimum text size: 14 on phone screens

## Sizing and layout
- Size with Scale (UDim2) plus UISizeConstraint/UITextSizeConstraint, not fixed pixels
- Spacing steps: 4 · 8 · 12 · 16 · 24 (UIPadding, UIListLayout.Padding)
- Respect the top bar inset and phone safe areas; keep touch targets large enough to tap
- Layouts: UIListLayout / UIGridLayout; corners: UICorner 8

## Motion
- TweenService, 0.15–0.25 s, Quad Out for UI transitions

## Accessibility
- Don't rely on colour alone; keep strong contrast between text and background
`,
  'Screens/_Index.md': () => `# Screens

| Screen | Status | Note |
| --- | --- | --- |

Add a row per screen and link its note, e.g. [[Screens/HUD|HUD]]. Copy [[Screens/_Template]] for new ones.
`,
  'Screens/_Template.md': () => `---
status: idea   # idea | in-progress | done
tags: [ui, screen]
---
# Screen name

## Purpose
What the player does here.

## Layout
Rough sketch or description, top to bottom.

## Elements
- Element — behaviour

## States
Empty, loading, error, mobile vs desktop.

## Implementation
- Files: \`src/client/UI/...\`
- Remotes used:

## Open questions
`,
  'Components/_Index.md': () => `# Components

| Component | Used on | Note |
| --- | --- | --- |

Copy [[Components/_Template]] for new ones.
`,
  'Components/_Template.md': () => `---
tags: [ui, component]
---
# Component name

## What it is

## Props / options

## Variants and states

## Implementation
- File: \`src/client/UI/Components/...\`

## Used on
`,
  'Decisions.md': () => `# Decisions

Newest first. One entry per decision: what, why, alternatives considered.

## ${today()} — Vault created
Started a UI vault so agents and people share one source of truth for the interface.
`,
  'Inbox.md': () => `# Inbox

Write UI requests and ideas here; the UI Builder picks them up and moves them into the right notes when done.

- [ ]
`
}

export interface VaultStatus {
  folder: string
  exists: boolean
  notes: number
}

function countNotes(dir: string): number {
  let n = 0
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) n += countNotes(full)
    else if (name.endsWith('.md')) n++
  }
  return n
}

export function vaultStatus(projectRoot: string, folder: string): VaultStatus {
  if (!validVaultFolder(folder)) throw new Error('Invalid vault folder name.')
  const dir = join(projectRoot, folder)
  const exists = existsSync(dir) && statSync(dir).isDirectory()
  return { folder, exists, notes: exists ? countNotes(dir) : 0 }
}

/** Create the vault from templates. Existing notes are never overwritten. Returns the files created. */
export function createVault(projectRoot: string, folder: string): string[] {
  if (!validVaultFolder(folder)) throw new Error('Invalid vault folder name.')
  const created: string[] = []
  for (const [rel, body] of Object.entries(TEMPLATES)) {
    const file = join(projectRoot, folder, rel)
    if (existsSync(file)) continue
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body(), { encoding: 'utf8', flag: 'wx' })
    created.push(`${folder}/${rel}`)
  }
  return created
}

/** Added to the instructions of a role that has a vault. */
export function vaultInstructions(folder: string): string {
  return `
# Your Obsidian vault: ${folder}/
This project's ${folder === 'ui-vault' ? 'UI ' : ''}knowledge base. The user reads and edits it in Obsidian, so keep it accurate and tidy.
- Before working: read ${folder}/Home.md, ${folder}/Style Guide.md and ${folder}/Inbox.md, plus the notes for the screens or components involved.
- Follow the Style Guide. If you must deviate, add a short entry to ${folder}/Decisions.md saying why.
- After changing the UI: create or update the matching notes in ${folder}/Screens and ${folder}/Components (status, elements, states, mobile notes, file paths), add new notes to the _Index tables, and link notes with [[wikilinks]].
- When you finish an Inbox item, tick it and link the note where it now lives.
- Plain Markdown and Obsidian links only. Never create or edit anything in a .obsidian folder.`
}
