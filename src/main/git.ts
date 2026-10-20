import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitFile, GitStatus } from '@shared/types'
import { isInsideRoot } from './pathScope'

/** A hooks folder that never exists, so git finds no hooks to run. */
const NO_HOOKS_DIR = join(tmpdir(), `hangar-no-hooks-${randomUUID()}`)

/**
 * Config forced onto every git process Hangar starts, and onto the agents' environment.
 * GIT_CONFIG_COUNT entries have command-line priority, so a repository's own .git/config
 * cannot turn these back on. This stops fsmonitor commands, hooks, pagers and commit
 * signing programs from running just because git was invoked.
 */
const FORCED_CONFIG: [string, string][] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NO_HOOKS_DIR],
  ['core.pager', 'cat'],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
  ['protocol.ext.allow', 'never']
]

export function gitSafetyEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(FORCED_CONFIG.length),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
  }
  FORCED_CONFIG.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/** Run git with an argument array (never through a shell), inside the project folder, with forced safe config. */
function git(cwd: string, args: string[], opts: { okExitCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...gitSafetyEnv() }
    execFile('git', args, { cwd, env, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : null
      if (err && !(code !== null && opts.okExitCodes?.includes(code))) reject(new Error((stderr || err.message).trim()))
      else resolvePromise(stdout)
    })
  })
}

export function parsePorcelain(out: string): GitFile[] {
  // `git status --porcelain=v1 -z`: entries are NUL-separated; renames carry an extra NUL-separated source path.
  const parts = out.split('\0').filter((p) => p !== '')
  const files: GitFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    const status = entry.slice(0, 2)
    files.push({ path: entry.slice(3), status })
    if (status.startsWith('R') || status.startsWith('C')) i++
  }
  return files
}

function assertInside(root: string, file: string): void {
  if (!file || !isInsideRoot(root, file)) throw new Error('File is outside the project folder.')
}

/**
 * Repository-level git config that makes ordinary git commands run other programs
 * (clean/smudge filters, textconv, external diff, merge drivers, signing programs, includes).
 * Entries in the repository's own scope are reported; your global ~/.gitconfig is trusted.
 */
const DANGEROUS_KEY = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^diff\.external$/,
  /^merge\..+\.driver$/,
  /^gpg\.(.+\.)?program$/,
  /^core\.(fsmonitor|hookspath|pager|editor|sshcommand|askpass|gitproxy)$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^uploadpack\.packobjectshook$/
]

export async function dangerousGitConfig(root: string): Promise<string[]> {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return []
  } catch {
    return [] // not a git repository (or git isn't installed): nothing to run
  }
  let out: string
  try {
    // Reading config never runs anything. With -z each entry is: scope NUL origin NUL key\nvalue NUL.
    out = await git(root, ['config', '--list', '--show-scope', '--show-origin', '-z'])
  } catch (e) {
    // Fail closed: if the repository's config can't be read, treat it as unsafe.
    return [`(could not read this repository's git config: ${(e as Error).message})`]
  }
  const found: string[] = []
  const parts = out.split('\0')
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i]!
    const origin = parts[i + 1]!.replace(/^file:/, '')
    const entry = parts[i + 2]!
    // Your own global and system config are trusted; anything belonging to the repository is not,
    // wherever the file lives (a parent folder's repo, a .git file pointing elsewhere, an include).
    if (scope !== 'local' && scope !== 'worktree') continue
    const nl = entry.indexOf('\n')
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase()
    const value = nl === -1 ? '' : entry.slice(nl + 1)
    if (DANGEROUS_KEY.some((re) => re.test(key))) found.push(`${key} = ${value}  (${origin})`)
  }
  return found
}

async function assertSafeRepo(root: string): Promise<void> {
  const bad = await dangerousGitConfig(root)
  if (bad.length) {
    throw new Error(
      `This repository's git config can make git run other programs, so Hangar won't run git here:\n${bad.join('\n')}\nReview .git/config and remove these entries if you didn't add them.`
    )
  }
}

export async function gitStatus(root: string): Promise<GitStatus> {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return { isRepo: false, branch: null, files: [] }
  } catch {
    return { isRepo: false, branch: null, files: [] }
  }
  await assertSafeRepo(root)
  const [branchOut, statusOut] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ])
  return { isRepo: true, branch: branchOut.trim() || null, files: parsePorcelain(statusOut) }
}

export async function gitDiff(root: string, file?: string): Promise<string> {
  if (file) assertInside(root, file)
  await assertSafeRepo(root)
  const pathArgs = file ? ['--', file] : []
  const safe = ['--no-color', '--no-ext-diff', '--no-textconv']
  let tracked = await git(root, ['diff', 'HEAD', ...safe, ...pathArgs]).catch(() =>
    // A repo with no commits yet has no HEAD; diff against the empty index instead.
    git(root, ['diff', ...safe, ...pathArgs])
  )
  // Show untracked files as additions so new files are reviewable too.
  const status = await gitStatus(root)
  const untracked = status.files.filter((f) => f.status === '??' && (!file || f.path === file))
  for (const f of untracked.slice(0, 50)) {
    // `--no-index` exits with 1 when the files differ, which is always the case here.
    const add = await git(root, ['diff', ...safe, '--no-index', '--', devNull(), f.path], { okExitCodes: [1] }).catch(
      (e: Error) => `(could not diff ${f.path}: ${e.message})`
    )
    tracked += add.endsWith('\n') ? add : add + '\n'
  }
  return tracked
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

export async function gitCommit(root: string, message: string): Promise<void> {
  const msg = message.trim()
  if (!msg) throw new Error('Commit message is empty.')
  await assertSafeRepo(root)
  await git(root, ['add', '-A'])
  await git(root, ['commit', '--no-verify', '-m', msg])
}

/** Restore a tracked file to its last committed version. Untracked files are deleted (to the OS trash by the caller). */
export async function gitRevertFile(root: string, file: string): Promise<'restored' | 'untracked'> {
  assertInside(root, file)
  const status = await gitStatus(root) // also refuses repos with dangerous config
  const entry = status.files.find((f) => f.path === file)
  if (!entry) return 'restored'
  if (entry.status === '??') return 'untracked'
  if (entry.status.startsWith('A')) {
    await git(root, ['rm', '--cached', '--', file])
    return 'untracked'
  }
  await git(root, ['restore', '--staged', '--worktree', '--source=HEAD', '--', file])
  return 'restored'
}

export async function gitInit(root: string): Promise<void> {
  await git(root, ['init'])
}
