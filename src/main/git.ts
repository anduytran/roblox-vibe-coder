import { execFile } from 'node:child_process'
import type { GitFile, GitStatus } from '@shared/types'
import { isInsideRoot } from './pathScope'

/** Run git with an argument array (never through a shell), inside the project folder. */
function git(cwd: string, args: string[], opts: { okExitCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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

export async function gitStatus(root: string): Promise<GitStatus> {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return { isRepo: false, branch: null, files: [] }
  } catch {
    return { isRepo: false, branch: null, files: [] }
  }
  const [branchOut, statusOut] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ])
  return { isRepo: true, branch: branchOut.trim() || null, files: parsePorcelain(statusOut) }
}

export async function gitDiff(root: string, file?: string): Promise<string> {
  if (file) assertInside(root, file)
  const pathArgs = file ? ['--', file] : []
  let tracked = await git(root, ['diff', 'HEAD', '--no-color', ...pathArgs]).catch(() =>
    // A repo with no commits yet has no HEAD; diff against the empty index instead.
    git(root, ['diff', '--no-color', ...pathArgs])
  )
  // Show untracked files as additions so new files are reviewable too.
  const status = await gitStatus(root)
  const untracked = status.files.filter((f) => f.status === '??' && (!file || f.path === file))
  for (const f of untracked.slice(0, 50)) {
    // `--no-index` exits with 1 when the files differ, which is always the case here.
    const add = await git(root, ['diff', '--no-color', '--no-index', '--', devNull(), f.path], { okExitCodes: [1] }).catch(
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
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-m', msg])
}

/** Restore a tracked file to its last committed version. Untracked files are deleted (to the OS trash by the caller). */
export async function gitRevertFile(root: string, file: string): Promise<'restored' | 'untracked'> {
  assertInside(root, file)
  const status = await gitStatus(root)
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
