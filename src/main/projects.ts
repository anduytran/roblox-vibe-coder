import { normalizeModel } from '@shared/models'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AppSettings, CheckCommand, Project, ProjectSettings } from '@shared/types'
import { JsonStore } from './jsonStore'
import { BLENDER_MCP_NAME, shellWords, STUDIO_MCP_NAME } from './permissions'

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  robloxStudioMcp: true,
  autoApproveEdits: false,
  allowedBashPrefixes: ['git status', 'git status *', 'selene *', 'stylua --check *'],
  alwaysAllowTools: [],
  dailyBudgetUsd: null,
  model: null,
  sandbox: true,
  sandboxAllowedDomains: [],
  autonomous: false,
  testPlace: null,
  checks: [],
  reviewer: true,
  safetyChecker: false
}

export class ProjectRegistry {
  private store: JsonStore<{ projects: Project[] }>

  constructor(file: string) {
    this.store = new JsonStore(file, { projects: [] as Project[] })
  }

  list(): Project[] {
    // A model typed by hand before the dropdown ("claude-opus-5.5") is read as the model it means.
    return this.store.get().projects.map((p) => ({ ...p, settings: { ...DEFAULT_PROJECT_SETTINGS, ...p.settings, model: normalizeModel(p.settings?.model) } }))
  }

  get(id: string): Project {
    const p = this.list().find((x) => x.id === id)
    if (!p) throw new Error('Project not found.')
    return p
  }

  add(folder: string): Project {
    const path = resolve(folder)
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('That folder does not exist.')
    const existing = this.list().find((p) => p.path === path)
    if (existing) return existing
    const project: Project = {
      id: randomUUID(),
      name: basename(path),
      path,
      createdAt: Date.now(),
      settings: { ...DEFAULT_PROJECT_SETTINGS }
    }
    this.store.update((s) => ({ projects: [...s.projects, project] }))
    return project
  }

  remove(id: string): void {
    this.store.update((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  }

  update(id: string, patch: { name?: string; settings?: Partial<ProjectSettings> }): Project {
    const current = this.get(id)
    const next: Project = {
      ...current,
      name: patch.name?.trim() ? patch.name.trim().slice(0, 80) : current.name,
      settings: sanitizeSettings({ ...current.settings, ...(patch.settings ?? {}) })
    }
    this.store.update((s) => ({ projects: s.projects.map((p) => (p.id === id ? next : p)) }))
    return next
  }
}

/** Check commands must be plain words (no quotes, variables, chaining or redirection): Hangar runs them without a shell. */
export function sanitizeChecks(v: unknown): CheckCommand[] {
  if (!Array.isArray(v)) return []
  const out: CheckCommand[] = []
  for (const c of v.slice(0, 10)) {
    if (!c || typeof c !== 'object') continue
    const command = typeof (c as CheckCommand).command === 'string' ? (c as CheckCommand).command.trim().replace(/\s+/g, ' ').slice(0, 300) : ''
    if (!command || !shellWords(command)) continue
    const name = typeof (c as CheckCommand).name === 'string' && (c as CheckCommand).name.trim() ? (c as CheckCommand).name.trim().slice(0, 40) : command.split(' ')[0]!
    out.push({ name, command })
  }
  return out
}

function sanitizeSettings(s: ProjectSettings): ProjectSettings {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : []
  const budget = typeof s.dailyBudgetUsd === 'number' && s.dailyBudgetUsd > 0 ? s.dailyBudgetUsd : null
  return {
    robloxStudioMcp: Boolean(s.robloxStudioMcp),
    autoApproveEdits: Boolean(s.autoApproveEdits),
    allowedBashPrefixes: strings(s.allowedBashPrefixes),
    alwaysAllowTools: strings(s.alwaysAllowTools),
    dailyBudgetUsd: budget,
    model: normalizeModel(s.model),
    sandbox: s.sandbox !== false,
    autonomous: Boolean(s.autonomous),
    testPlace:
      s.testPlace && /^\d{1,20}$/.test(String(s.testPlace.universeId)) && /^\d{1,20}$/.test(String(s.testPlace.placeId))
        ? { universeId: String(s.testPlace.universeId), placeId: String(s.testPlace.placeId) }
        : null,
    sandboxAllowedDomains: strings(s.sandboxAllowedDomains).filter((d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)),
    checks: sanitizeChecks(s.checks),
    reviewer: s.reviewer !== false,
    safetyChecker: s.safetyChecker === true
  }
}

export interface StdioServer {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** Roblox Studio's built-in MCP server launch command for this OS (from Roblox's docs). */
export function defaultStudioMcp(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): StdioServer | null {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (!local) return null
    return { command: 'cmd.exe', args: ['/c', join(local, 'Roblox', 'mcp.bat')] }
  }
  if (platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP' }
  }
  return null
}

/**
 * Stdio servers declared in the project's .mcp.json. These launch programs, so the runner only
 * uses them after the user approves the exact commands (see projectTrust.ts).
 * A project may not claim the reserved Roblox Studio name, whose read-only tools are auto-allowed.
 */
export function projectMcpServers(projectPath: string): Record<string, StdioServer> {
  const file = join(projectPath, '.mcp.json')
  const servers: Record<string, StdioServer> = {}
  if (!existsSync(file)) return servers
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, StdioServer> }
    for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
      // Any spelling that the engine could turn into a reserved name (Roblox-Studio, roblox studio, BLENDER, …):
      // those connections only ever come from Hangar's own settings, and some of their tools are pre-approved.
      const squash = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]/g, '')
      if ([STUDIO_MCP_NAME, BLENDER_MCP_NAME].some((r) => squash(name) === squash(r))) continue
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue
      if (!cfg || typeof cfg.command !== 'string') continue
      servers[name] = {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args.filter((a): a is string => typeof a === 'string') } : {}),
        ...(cfg.env && typeof cfg.env === 'object' ? { env: Object.fromEntries(Object.entries(cfg.env).filter(([, v]) => typeof v === 'string')) } : {})
      }
    }
  } catch {
    // An invalid .mcp.json is ignored; the agent still runs without those servers.
  }
  return servers
}

/**
 * MCP servers for a run: the already-reviewed project servers plus Roblox Studio when enabled.
 * Taking the reviewed set (instead of re-reading .mcp.json) means a file changed after approval
 * can't swap in a different command.
 */
export function mcpServersFor(project: Project, app: AppSettings, reviewed: Record<string, StdioServer> = {}, opts: { blender?: boolean } = {}): Record<string, StdioServer> {
  const servers: Record<string, StdioServer> = { ...reviewed }
  // Only a role that asks for Blender gets it, and only once the owner has set the command up in Settings.
  const blender = app.blenderMcpCommand?.trim()
  if (opts.blender && blender) servers[BLENDER_MCP_NAME] = { command: blender, args: app.blenderMcpArgs ?? [] }
  if (project.settings.robloxStudioMcp) {
    const custom = app.studioMcpCommand.trim()
    const studio = custom ? { command: custom, args: app.studioMcpArgs } : defaultStudioMcp(process.platform, process.env)
    if (studio) servers[STUDIO_MCP_NAME] = studio
  }
  return servers
}
