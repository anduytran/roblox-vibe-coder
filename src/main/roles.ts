import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Role } from '@shared/types'

/** Roles live in <project>/.claude/agents/*.md, the same format Claude Code uses for subagents. */
export function agentsDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'agents')
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

function parseList(v: string): string[] {
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

export function parseRole(id: string, text: string): Role | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
  }
  const role: Role = {
    id,
    name: meta.name || id,
    description: meta.description || '',
    prompt: m[2]!.trim()
  }
  if (meta.tools) role.tools = parseList(meta.tools)
  if (meta.model && meta.model !== 'inherit') role.model = meta.model
  return role
}

export function serializeRole(role: Role): string {
  const lines = ['---', `name: ${role.name.replace(/\n/g, ' ')}`, `description: ${role.description.replace(/\n/g, ' ')}`]
  if (role.tools && role.tools.length > 0) lines.push(`tools: ${role.tools.join(', ')}`)
  if (role.model) lines.push(`model: ${role.model}`)
  lines.push('---', '', role.prompt.trim(), '')
  return lines.join('\n')
}

export function listRoles(projectRoot: string): Role[] {
  const dir = agentsDir(projectRoot)
  if (!existsSync(dir)) return []
  const roles: Role[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const id = file.slice(0, -3)
    if (!ID_RE.test(id)) continue
    try {
      const role = parseRole(id, readFileSync(join(dir, file), 'utf8'))
      if (role) roles.push(role)
    } catch {
      // Unreadable role files are skipped rather than breaking the whole project.
    }
  }
  return roles.sort((a, b) => a.name.localeCompare(b.name))
}

export function saveRole(projectRoot: string, role: Role): void {
  const id = role.id && ID_RE.test(role.id) ? role.id : slugify(role.name)
  if (!role.name.trim() || !role.prompt.trim()) throw new Error('A role needs a name and instructions.')
  const dir = agentsDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.md`), serializeRole({ ...role, id }), 'utf8')
}

export function deleteRole(projectRoot: string, roleId: string): void {
  if (!ID_RE.test(roleId)) throw new Error('Invalid role id.')
  rmSync(join(agentsDir(projectRoot), `${roleId}.md`), { force: true })
}

export const ROLE_TEMPLATES: Role[] = [
  {
    id: 'lead',
    name: 'Lead',
    description: 'Plans features, breaks them into steps and delegates to the other agents. Use for multi-part tasks.',
    prompt: `You are the lead developer on a Roblox game. Turn requests into a short plan, then do the work or
delegate pieces to the specialist subagents (scripter, ui-builder, qa-tester).
Follow CLAUDE.md for project conventions. Keep changes small and reviewable.
Finish every task by stating what changed and whether it was playtested.`
  },
  {
    id: 'scripter',
    name: 'Scripter',
    description: 'Writes and fixes Luau gameplay code: systems, modules, server/client logic.',
    prompt: `You write Luau for a Roblox game that is synced to disk with Rojo.
- Edit the .luau files in the project; do not paste code into chat.
- Follow the module patterns and naming already used in the codebase and CLAUDE.md.
- Keep server authority: never trust the client for game state.
- After changes, if Roblox Studio tools are available, start a playtest, read the console output,
  fix any errors, and stop the playtest.
- End with a short summary of files changed.`
  },
  {
    id: 'ui-builder',
    name: 'UI Builder',
    description: 'Builds and adjusts game UI: ScreenGuis, layouts, UI scripts.',
    prompt: `You build user interface for a Roblox game.
- Prefer UI defined in code (or Rojo model files) so it can be reviewed in git.
- Use UIListLayout/UIGridLayout/UIPadding and scale-based sizing so it works on phone and desktop.
- Keep UI logic in LocalScripts/ModuleScripts on the client; send requests to the server via RemoteEvents.
- Playtest when Studio tools are available and check the console for errors.`
  },
  {
    id: 'qa-tester',
    name: 'QA Tester',
    description: 'Playtests, reads console output and reports bugs with reproduction steps. Does not edit code.',
    tools: ['Read', 'Glob', 'Grep'],
    prompt: `You are QA for a Roblox game. You do not edit files.
- Read the relevant code, then (when Roblox Studio tools are available) run playtests and read console output.
- Report each problem as: title, steps to reproduce, expected vs actual, likely file and line.
- Say clearly when everything passed.`
  }
]

export function installTemplates(projectRoot: string): void {
  const existing = new Set(listRoles(projectRoot).map((r) => r.id))
  for (const t of ROLE_TEMPLATES) if (!existing.has(t.id)) saveRole(projectRoot, t)
}
