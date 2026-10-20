import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { NewGameInput } from '@shared/types'
import { gitInitialCommit } from './git'
import { DECEPTIVE_CHARS } from './permissions'
import { installTemplates } from './roles'
import { createVault } from './vault'

/**
 * "New game": creates a ready-to-build Rojo project from the wizard — folder layout, Rojo project file,
 * lint/format config, CLAUDE.md conventions, the starter roles (Lead, Scripter, UI Builder, QA, Researcher),
 * the Lead's design vault with your brief in it, and a first git commit, so autonomous mode can start
 * straight away.
 */
export const MAX_DOCUMENT = 300_000

export function projectFolderName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .replace(/^[-_.]+|[-_.]+$/g, '') || 'new-game'
  )
}

const clean = (s: string, max: number): string => s.replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), (c) => (c === '\n' || c === '\t' ? c : '')).slice(0, max)
/** A string that is safe inside a Luau double-quoted string. */
const luauString = (s: string): string => JSON.stringify(s.replace(/[^\w .,!?'-]/g, '').slice(0, 60))

const PLATFORM_NAMES: Record<string, string> = { phone: 'Phone and tablet', pc: 'PC', console: 'Console', vr: 'VR' }

export function briefMarkdown(input: Pick<NewGameInput, 'name' | 'idea' | 'document' | 'platforms' | 'genre' | 'notes'>): string {
  const lines = [
    '---',
    'tags: [design, brief]',
    '---',
    `# Game brief: ${clean(input.name, 80)}`,
    '',
    '> Written by the product owner when the project was created. The Lead turns this into the Game Overview, mechanics and roadmap. Change it any time; the Lead re-reads it every sprint.',
    '',
    '## The idea',
    clean(input.idea, 20_000).trim() || '(No description given; see the attached document.)',
    ''
  ]
  if (input.platforms.length) lines.push('## Platforms', input.platforms.map((p) => `- ${PLATFORM_NAMES[p] ?? p}`).join('\n'), '')
  if (input.genre.trim()) lines.push('## Genre', clean(input.genre, 200).trim(), '')
  if (input.notes.trim()) lines.push('## Notes and constraints', clean(input.notes, 10_000).trim(), '')
  if (input.document) {
    lines.push(`## Attached document: ${clean(input.document.name, 120)}`, '', clean(input.document.text, MAX_DOCUMENT).trim(), '')
  }
  return lines.join('\n')
}

function claudeMd(name: string): string {
  return `# ${clean(name, 80)}

A Roblox game built with Rojo. Code in \`src/\` syncs into Roblox Studio with \`rojo serve\`.

## Layout
- \`src/server\` → ServerScriptService.Server (Scripts end in \`.server.luau\`)
- \`src/client\` → StarterPlayer.StarterPlayerScripts.Client (LocalScripts end in \`.client.luau\`)
- \`src/shared\` → ReplicatedStorage.Shared (ModuleScripts)

## Conventions
- Luau. Use \`--!strict\` where practical. ModuleScripts return a table; PascalCase module names, camelCase functions.
- The server is the authority: validate every RemoteEvent/RemoteFunction argument, rate and ownership on the server.
- Create remotes in code (in \`src/shared\`), not by hand in Studio.
- Build UI in code under \`src/client/UI\` so it can be reviewed.
- Keep changes small: one feature or fix per task.
- Don't install packages or tools. If you need one, say so in your final message.

## Design
- The game design lives in \`design-vault/\`: start with \`Brief.md\` (the product owner's idea), then \`Game Overview.md\`, \`Roadmap.md\` and the mechanic notes.
- The UI spec lives in \`ui-vault/\`.
- Approved web research lives in \`research/\`.

## Checks
These must pass before work is merged: \`stylua --check src\`, \`selene src\`, \`rojo build -o hangar-check.rbxl\`.
`
}

function files(name: string, slug: string): Record<string, string> {
  return {
    'default.project.json': `${JSON.stringify(
      {
        name: slug,
        tree: {
          $className: 'DataModel',
          ReplicatedStorage: { Shared: { $path: 'src/shared' } },
          ServerScriptService: { Server: { $path: 'src/server' } },
          StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client' } } }
        }
      },
      null,
      2
    )}\n`,
    'src/server/main.server.luau': `--!strict\nlocal Config = require(game:GetService("ReplicatedStorage").Shared.Config)\n\nprint(\`[server] {Config.GAME_NAME} started\`)\n`,
    'src/client/main.client.luau': `--!strict\nlocal Config = require(game:GetService("ReplicatedStorage").Shared.Config)\n\nprint(\`[client] Welcome to {Config.GAME_NAME}\`)\n`,
    'src/shared/Config.luau': `--!strict\nreturn {\n\tGAME_NAME = ${luauString(name)},\n}\n`,
    'selene.toml': 'std = "roblox"\n',
    'stylua.toml': 'column_width = 120\nindent_type = "Tabs"\nquote_style = "AutoPreferDouble"\n',
    '.gitignore': ['Packages/', 'ServerPackages/', 'DevPackages/', '*.rbxl', '*.rbxlx', '*.rbxl.lock', 'sourcemap.json', 'hangar-check.rbxl', '.env', 'node_modules/', ''].join('\n'),
    'CLAUDE.md': claudeMd(name),
    'research/README.md': '# Research\n\nWeb research the product owner reviewed and approved. Agents may read it as background information.\n'
  }
}

/** Create the project folder and everything in it. Returns the new folder's path. */
export async function createGameProject(input: NewGameInput): Promise<string> {
  const name = clean(input.name, 80).trim()
  if (!name) throw new Error('Give the game a name.')
  if (!input.idea.trim() && !input.document) throw new Error('Describe the game idea or attach a design document.')
  if (!isAbsolute(input.parentDir) || !existsSync(input.parentDir) || !statSync(input.parentDir).isDirectory()) throw new Error('Choose a folder to create the project in.')
  const slug = projectFolderName(name)
  const root = join(input.parentDir, slug)
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} already exists and isn't empty. Choose another name or folder.`)
  mkdirSync(root, { recursive: true })
  for (const [rel, body] of Object.entries(files(name, slug))) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' })
  }
  installTemplates(root)
  createVault(root, 'design-vault', 'design')
  writeFileSync(join(root, 'design-vault', 'Brief.md'), briefMarkdown({ ...input, name }), { encoding: 'utf8', flag: 'wx' })
  createVault(root, 'ui-vault', 'ui')
  await gitInitialCommit(root, `New game: ${name}`)
  return root
}

const PLATFORMS = new Set(['phone', 'pc', 'console', 'vr'])

/** Check and normalise wizard input from the UI (never trust its shape). */
export function sanitizeNewGame(raw: unknown): NewGameInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project details.')
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const doc = r.document && typeof r.document === 'object' ? (r.document as Record<string, unknown>) : null
  const ap = r.autopilot && typeof r.autopilot === 'object' ? (r.autopilot as Record<string, unknown>) : {}
  const n = (v: unknown, min: number, max: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d)
  const budget = typeof r.dailyBudgetUsd === 'number' && Number.isFinite(r.dailyBudgetUsd) && r.dailyBudgetUsd > 0 ? Math.min(10_000, r.dailyBudgetUsd) : null
  return {
    name: str(r.name, 80),
    parentDir: str(r.parentDir, 1000),
    idea: str(r.idea, 20_000),
    document: doc && typeof doc.text === 'string' && doc.text.trim() ? { name: str(doc.name, 120) || 'document', text: str(doc.text, MAX_DOCUMENT) } : null,
    platforms: (Array.isArray(r.platforms) ? r.platforms : []).filter((p): p is NewGameInput['platforms'][number] => typeof p === 'string' && PLATFORMS.has(p)),
    genre: str(r.genre, 200),
    notes: str(r.notes, 10_000),
    model: typeof r.model === 'string' && /^[a-z0-9.-]{3,60}$/i.test(r.model) ? r.model : null,
    dailyBudgetUsd: budget,
    studioTools: r.studioTools !== false,
    autopilot: {
      sprintTasks: Math.round(n(ap.sprintTasks, 1, 20, 5)),
      sprintBudgetUsd: n(ap.sprintBudgetUsd, 0.5, 500, 10),
      autoMerge: ap.autoMerge !== false
    },
    startNow: r.startNow !== false
  }
}
