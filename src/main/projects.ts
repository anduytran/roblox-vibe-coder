import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AppSettings, Project, ProjectSettings } from '@shared/types'
import { JsonStore } from './jsonStore'
import { STUDIO_MCP_NAME } from './permissions'

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  robloxStudioMcp: true,
  autoApproveEdits: false,
  allowedBashPrefixes: ['git status', 'git diff', 'git log', 'rojo build', 'selene', 'stylua --check'],
  alwaysAllowTools: [],
  dailyBudgetUsd: null,
  model: null
}

export class ProjectRegistry {
  private store: JsonStore<{ projects: Project[] }>

  constructor(file: string) {
    this.store = new JsonStore(file, { projects: [] as Project[] })
  }

  list(): Project[] {
    return this.store.get().projects.map((p) => ({ ...p, settings: { ...DEFAULT_PROJECT_SETTINGS, ...p.settings } }))
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
    model: typeof s.model === 'string' && s.model.trim() ? s.model.trim() : null
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

/** MCP servers for a project: its own .mcp.json plus Roblox Studio when enabled. */
export function mcpServersFor(project: Project, app: AppSettings): Record<string, StdioServer> {
  const servers: Record<string, StdioServer> = {}
  const file = join(project.path, '.mcp.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, StdioServer> }
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (cfg && typeof cfg.command === 'string') servers[name] = cfg
      }
    } catch {
      // An invalid .mcp.json is ignored; the agent still runs without those servers.
    }
  }
  if (project.settings.robloxStudioMcp) {
    const custom = app.studioMcpCommand.trim()
    const studio = custom ? { command: custom, args: app.studioMcpArgs } : defaultStudioMcp(process.platform, process.env)
    if (studio) servers[STUDIO_MCP_NAME] = studio
  }
  return servers
}
