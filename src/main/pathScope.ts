import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Resolve symlinks for the deepest part of the path that exists, so links can't escape the project. */
function realish(p: string): string {
  let current = p
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return p
    tail.unshift(current.slice(parent.length).replace(/^[\\/]/, ''))
    current = parent
  }
  try {
    // .native canonicalises Windows 8.3 short names (GIT~1) and letter case.
    return resolve(realpathSync.native(current), ...tail)
  } catch {
    return p
  }
}

/**
 * Paths a tool might expand differently than Node does: home shortcuts (~), environment
 * variables ($HOME, %USERPROFILE%) and network shares. These are never treated as inside the project.
 */
export function isSuspiciousPath(p: string): boolean {
  if (/^~/.test(p) || /[$%]/.test(p) || /^\\\\|^\/\//.test(p)) return true
  // Windows tricks that reach a different file than the name suggests: alternate data streams
  // (name::$DATA, a colon after the drive letter), 8.3 short names (GIT~1), and segments ending
  // in dots or spaces, which Windows silently strips (".git./config" is ".git/config").
  const withoutDrive = p.replace(/^[A-Za-z]:/, '')
  if (withoutDrive.includes(':')) return true
  return p.split(/[\\/]/).some((seg) => /~\d/.test(seg) || (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)))
}

/** The path relative to the project root using forward slashes, or null if it is outside (or suspicious). */
export function relativeInside(root: string, target: string): string | null {
  if (isSuspiciousPath(target)) return null
  const realRoot = realish(resolve(root))
  const abs = realish(isAbsolute(target) ? resolve(target) : resolve(root, target))
  const rel = relative(realRoot, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(/[\\/]/).join('/')
}

/** True if `target` (absolute, or relative to `root`) is inside `root` or is `root` itself. */
export function isInsideRoot(root: string, target: string): boolean {
  return relativeInside(root, target) !== null
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Paths a tool call will touch, taken from its known input fields. */
export function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') out.push(v)
  }
  return out
}

/** True if a search pattern (Glob `pattern`, Grep `glob`) could reach outside the project. */
export function patternEscapes(pattern: string): boolean {
  const p = pattern.trim()
  // Brace alternatives can hide absolute or parent paths: {..,x}/**, {/etc,x}/*
  // Also judge the pattern with glob syntax removed, so [.][.]/x, {.{.,},x}/a or {/etc,x} can't hide.
  const flat = p.replace(/[[\]{},]/g, '')
  return (
    isAbsolute(p) || /^[A-Za-z]:/.test(p) || isSuspiciousPath(p) || p.includes('..') ||
    flat.includes('..') || isAbsolute(flat) || /^[A-Za-z]:/.test(flat) || /[{,]\s*([/\\]|[A-Za-z]:|~)/.test(p)
  )
}

/**
 * Files and folders inside the project that can change how code runs or how agents behave:
 * git config and hooks, agent/editor/CI config, CLAUDE.md, package and toolchain manifests,
 * direnv and make files. They are matched at any depth and case-insensitively.
 * Edits to these always ask, with a warning, whatever the project settings say.
 */
const PROTECTED_DIRS = new Set([
  '.git', '.claude', '.vscode', '.github', '.husky', '.idea', '.cursor', '.devcontainer', '.zed', '.windsurf', '.vs'
])
const PROTECTED_FILES = new Set([
  '.mcp.json', 'claude.md', '.gitattributes', '.gitmodules', '.npmrc', 'package.json', '.envrc', 'makefile',
  'rokit.toml', 'aftman.toml', 'foreman.toml', 'wally.toml', '.lfsconfig', '.pre-commit-config.yaml',
  'mise.toml', '.mise.toml', '.tool-versions', '.gitignore'
])

/** Extra protected folders: those holding scripts that the project's MCP servers run (set by the runner). */
const extraProtectedDirs = new Map<string, Set<string>>()
export function setServerScriptDirs(projectRoot: string, relDirs: string[]): void {
  extraProtectedDirs.set(projectRoot, new Set(relDirs.map((d) => d.toLowerCase())))
}
export function serverScriptDirs(projectRoot: string): string[] {
  return [...(extraProtectedDirs.get(projectRoot) ?? [])]
}

export function isProtectedPath(rel: string, projectRoot?: string): boolean {
  const lower = rel.toLowerCase()
  const extra = projectRoot ? extraProtectedDirs.get(projectRoot) : undefined
  if (extra) for (const d of extra) if (d !== '' && (lower === d || lower.startsWith(d + '/'))) return true
  const segs = lower.split('/').filter(Boolean)
  if (segs.some((seg) => PROTECTED_DIRS.has(seg))) return true
  const base = segs[segs.length - 1]
  return base !== undefined && PROTECTED_FILES.has(base)
}
