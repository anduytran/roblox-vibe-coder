import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project } from '@shared/types'
import { dangerousGitConfig } from './git'
import { relativeInside, setServerScriptDirs } from './pathScope'
import { JsonStore } from './jsonStore'
import { projectMcpServers, type StdioServer } from './projects'

/**
 * Things inside a project folder that would run programs as soon as an agent starts:
 * MCP servers in .mcp.json and repository git config that executes commands.
 * A cloned or downloaded project could ship these, and an agent could add them, so they
 * must be approved (by content hash) before any run. A change means approving again.
 */
export interface ProjectReview {
  hash: string
  items: string[]
  /** The exact servers that were reviewed; the runner launches these, not a fresh read of the file. */
  servers: Record<string, StdioServer>
  /** Instructions agents will receive from the folder (CLAUDE.md, role files). Shown on first approval. */
  notes: string[]
}

const MAX_CLAUDE_MD = 30_000

/** Toolchain manifests that decide which binary `selene`, `stylua`, `rojo`… actually run (and may download). */
const TOOLCHAIN_FILES = ['rokit.toml', 'aftman.toml', 'foreman.toml']
const MAX_SHOWN = 2_000

function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

const MAX_HASH_FILES = 2_000
const MAX_HASH_BYTES = 50 * 1024 * 1024

/** Paths inside the project that a server command or argument points to (including --flag=./path values). */
function referencedPaths(projectPath: string, words: string[]): string[] {
  const out: string[] = []
  for (const raw of words) {
    const word = raw.includes('=') && raw.startsWith('-') ? raw.slice(raw.indexOf('=') + 1) : raw
    if (!word || word.startsWith('-')) continue
    const target = isAbsolute(word) ? word : resolve(projectPath, word)
    const rel = relativeInside(projectPath, target)
    if (rel === null) continue
    try {
      const st = statSync(target)
      // A folder (e.g. `node .`) means everything in it can run: hash and protect the whole folder.
      if (st.isFile()) out.push(rel)
      else if (st.isDirectory()) out.push(rel === '' ? '.' : `${rel}/`)
    } catch {
      // not a file
    }
  }
  return out
}

/** Hash every file under a folder (bounded), so edits to modules a server script imports are caught too. */
function hashTree(root: string, rel: string, parts: string[], budget: { files: number; bytes: number }): void {
  const abs = rel ? join(root, rel) : root
  let entries: string[]
  try {
    entries = readdirSync(abs).sort()
  } catch {
    return
  }
  for (const name of entries) {
    if (name === '.git') continue
    const childRel = rel ? `${rel}/${name}` : name
    const full = join(root, childRel)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) hashTree(root, childRel, parts, budget)
    else if (st.isFile()) {
      if (--budget.files < 0 || (budget.bytes -= st.size) < 0) {
        parts.push('(too many files to hash)')
        return
      }
      parts.push(`${childRel}:${sha(readFileSync(full))}`)
    }
  }
}

export async function reviewProject(project: Project): Promise<ProjectReview> {
  const items: string[] = []
  const hashParts: string[] = []
  const scriptDirs = new Set<string>()
  const servers = projectMcpServers(project.path)
  for (const [name, cfg] of Object.entries(servers)) {
    const args = (cfg.args ?? []).map((a) => JSON.stringify(a)).join(' ')
    const env = Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    let line = `MCP server "${name}" (from .mcp.json) runs: ${JSON.stringify(cfg.command)} ${args}`
    if (env.length) line += `\n    with environment: ${env.join(' ')}`
    const runner = cfg.command.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd)$/, '') ?? ''
    const pkg = (cfg.args ?? []).find((a) => !a.startsWith('-'))
    if (['npx', 'uvx', 'pnpx', 'bunx'].includes(runner) && !(pkg && /.@\d/.test(pkg))) {
      line += `\n    ⚠ downloads the newest version of a package every time (no version pinned)`
    }
    items.push(line)
    // Scripts the server runs from inside the project, and everything in their folders, are part of
    // what is approved: editing any of them asks again, and agent edits there always ask in red.
    const refs = referencedPaths(project.path, [cfg.command, ...(cfg.args ?? [])])
    // npm/pnpm/yarn/bun/node run what package.json says.
    if (['npm', 'pnpm', 'yarn', 'bun', 'node', 'npx', 'pnpx', 'bunx'].includes(runner) && existsSync(join(project.path, 'package.json'))) refs.push('package.json')
    for (const rel of refs) {
      if (rel === '.') {
        // `node .` runs package.json's "main" file: hash and protect that (the whole project can't be frozen).
        try {
          const main = (JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')) as { main?: unknown }).main
          const mainRel = typeof main === 'string' ? relativeInside(project.path, resolve(project.path, main)) : null
          if (mainRel && existsSync(join(project.path, mainRel))) {
            scriptDirs.add(dirname(mainRel) === '.' ? mainRel : dirname(mainRel))
            hashParts.push(`${mainRel}:${sha(readFileSync(join(project.path, mainRel)))}`)
          }
        } catch {
          // no package.json main
        }
        continue
      }
      if (rel.endsWith('/')) {
        const dir = rel.slice(0, -1)
        scriptDirs.add(dir)
        hashTree(project.path, dir, hashParts, { files: MAX_HASH_FILES, bytes: MAX_HASH_BYTES })
        continue
      }
      const dir = dirname(rel)
      if (dir === '.' || dir === '') {
        scriptDirs.add(rel)
        hashParts.push(`${rel}:${sha(readFileSync(join(project.path, rel)))}`)
      } else {
        scriptDirs.add(dir)
        hashTree(project.path, dir, hashParts, { files: MAX_HASH_FILES, bytes: MAX_HASH_BYTES })
      }
    }
  }
  setServerScriptDirs(project.path, [...scriptDirs])
  const gitLines = await dangerousGitConfig(project.path)
  for (const line of gitLines) items.push(`git config: ${line}`)
  if (gitLines.length) {
    items.push('Hangar will not run git itself in this repository. If you approve, git commands that agents run (and that you approve) will use these settings.')
  }
  for (const file of TOOLCHAIN_FILES) {
    const full = join(project.path, file)
    if (!existsSync(full)) continue
    try {
      const text = readFileSync(full, 'utf8')
      items.push(`${file} chooses (and may download) these tools:\n${text.length > MAX_SHOWN ? text.slice(0, MAX_SHOWN) + '\n…' : text}`)
      hashParts.push(`${file}:${sha(text)}`)
    } catch {
      items.push(`${file} exists but could not be read`)
    }
  }
  // The hash covers the full server definitions (including env values), referenced scripts and
  // toolchain files, not just what is displayed.
  const hash = sha([JSON.stringify(servers), ...hashParts, ...items].join('\0'))

  // Instructions from the folder can steer agents (not run programs). Shown on a project's first approval.
  const notes: string[] = []
  const claudeMd = readClaudeMd(project.path)
  if (claudeMd) notes.push(`CLAUDE.md (${claudeMd.split('\n').length} lines) will be added to every agent's instructions.`)
  const agentsDir = join(project.path, '.claude', 'agents')
  const roleFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : []
  if (roleFiles.length) notes.push(`Role files in .claude/agents (${roleFiles.join(', ')}) define agents and may choose their model.`)
  return { hash, items, servers, notes }
}

export class TrustStore {
  private store: JsonStore<{ approved: Record<string, string> }>

  constructor(file: string) {
    this.store = new JsonStore(file, { approved: {} as Record<string, string> })
  }

  hasAny(projectId: string): boolean {
    return projectId in this.store.get().approved
  }

  isApproved(projectId: string, hash: string): boolean {
    return this.store.get().approved[projectId] === hash
  }

  approve(projectId: string, hash: string): void {
    this.store.update((s) => ({ approved: { ...s.approved, [projectId]: hash } }))
  }
}

/** CLAUDE.md is read by Hangar and added to each agent's instructions (capped in size). */
export function readClaudeMd(projectPath: string): string | null {
  const file = join(projectPath, 'CLAUDE.md')
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > MAX_CLAUDE_MD ? text.slice(0, MAX_CLAUDE_MD) + '\n…(truncated)' : text
  } catch {
    return null
  }
}
