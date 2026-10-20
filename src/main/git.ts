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

// ---------- branch-per-task (autonomous mode) ----------

const BRANCH_PREFIX = 'hangar/'
const SAFE_BRANCH = /^hangar\/[a-z0-9][a-z0-9-]{0,80}$/

function assertTaskBranch(branch: string): void {
  if (!SAFE_BRANCH.test(branch)) throw new Error('Invalid task branch name.')
}

/** Current branch name, or null when HEAD is detached or the repo has no commits. */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    const name = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    // A branch with no commits yet can't be branched from.
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return name || null
  } catch {
    return null
  }
}

export interface TaskBase {
  /** Branch the task started from. */
  base: string
  /** Commit the task started from; reviews diff and merge against this, not the branch name. */
  baseSha: string
  /** Every ref (branch, tag, ...) and the commit it pointed to when the task started. */
  refs: Record<string, string>
}

async function snapshotRefs(root: string): Promise<Record<string, string>> {
  const out = await git(root, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const refs: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const [name, sha] = line.trim().split(' ')
    if (name && sha) refs[name] = sha
  }
  return refs
}

/**
 * Checks before an autonomous task: a safe git repo, on a normal branch with at least one commit,
 * with no uncommitted changes (so the task's branch contains only the agent's work).
 */
export async function prepareTaskBase(root: string): Promise<TaskBase> {
  const status = await gitStatus(root) // refuses dangerous config
  if (!status.isRepo) throw new Error('Autonomous mode needs a git repository. Initialize one in the Changes tab.')
  const base = await currentBranch(root)
  if (!base) throw new Error('Autonomous mode needs a branch with at least one commit. Make a first commit in the Changes tab.')
  if (base.startsWith(BRANCH_PREFIX)) throw new Error(`You're on a task branch (${base}). Switch back to your main branch first.`)
  if (status.files.length > 0) {
    throw new Error('There are uncommitted changes. Commit or discard them in the Changes tab first, so a task branch only holds the agent\'s work.')
  }
  const baseSha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  return { base, baseSha, refs: await snapshotRefs(root) }
}

export function taskBranchName(agentId: string, prompt: string, id: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const agent = agentId.replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'agent'
  return `${BRANCH_PREFIX}${agent}-${slug || 'task'}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`
}

export async function startTaskBranch(root: string, branch: string, from: TaskBase): Promise<void> {
  assertTaskBranch(branch)
  await git(root, ['checkout', '-b', branch, from.baseSha])
}

/**
 * Put back any branch or tag the agent changed, created or deleted (everything except its own task
 * branch). Returns what was restored, so the user is told.
 */
async function restoreOtherRefs(root: string, from: TaskBase, branch: string): Promise<string[]> {
  const own = `refs/heads/${branch}`
  const now = await snapshotRefs(root)
  const restored: string[] = []
  for (const [ref, sha] of Object.entries(from.refs)) {
    if (ref === own) continue
    if (now[ref] !== sha) {
      await git(root, ['update-ref', ref, sha])
      restored.push(ref)
    }
  }
  for (const ref of Object.keys(now)) {
    if (ref === own || ref in from.refs || ref === 'refs/stash') continue
    await git(root, ['update-ref', '-d', ref])
    restored.push(ref)
  }
  return restored
}

export interface FinishedTask {
  files: string[]
  /** The task branch's final commit; what the review shows and what merge applies. */
  headSha: string | null
  note: string | null
}

/**
 * Commit everything the agent changed onto its branch (as "Hangar (<agent>)"), then switch back to
 * the base branch. Refuses to commit anywhere but the task branch, and undoes any change the agent
 * made to other branches or tags.
 */
export async function finishTaskBranch(root: string, branch: string, from: TaskBase, agentName: string, message: string): Promise<FinishedTask> {
  assertTaskBranch(branch)
  await assertSafeRepo(root)
  const notes: string[] = []
  const now = await currentBranch(root)
  if (now !== branch) {
    notes.push(`The agent switched branches (to ${now ?? 'a detached HEAD'}).`)
    try {
      await git(root, ['checkout', branch])
    } catch {
      throw new Error(
        `The agent left the project on ${now ?? 'a detached HEAD'} and Hangar couldn't switch back to ${branch} safely, so nothing was committed. Check the Changes tab.`
      )
    }
  }
  if ((await currentBranch(root)) !== branch) throw new Error(`Not on ${branch}; nothing was committed.`)

  const restored = await restoreOtherRefs(root, from, branch)
  if (restored.length) notes.push(`The agent changed other branches or tags; Hangar put them back: ${restored.join(', ')}.`)

  const tip = (await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim()
  const descends = await git(root, ['merge-base', '--is-ancestor', from.baseSha, tip]).then(() => true).catch(() => false)
  if (!descends) throw new Error(`The task branch no longer builds on ${from.base}'s starting point (its history was rewritten). It was kept for you to inspect: ${branch}.`)

  await git(root, ['add', '-A'])
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  if (staged.length > 0) {
    const who = agentName.replace(/[<>\n]/g, '').slice(0, 40)
    await git(root, ['-c', `user.name=Hangar (${who})`, '-c', 'user.email=hangar@localhost', 'commit', '--no-verify', '-m', message.slice(0, 200)])
  }
  const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  await git(root, ['checkout', from.base])
  const files = (await git(root, ['diff', '--name-only', '-z', from.baseSha, headSha])).split('\0').filter(Boolean)
  if (files.length === 0) await git(root, ['branch', '-D', branch]).catch(() => undefined)
  if (files.some((f) => /(^|\/)\.gitignore$/.test(f))) notes.push('This change edits .gitignore — check it doesn\'t hide or expose files you care about.')
  return { files, headSha: files.length ? headSha : null, note: notes.length ? notes.join(' ') : null }
}

const SHA = /^[0-9a-f]{40,64}$/

/** The reviewed change: exactly from the task's starting commit to the commit Hangar recorded. */
export async function reviewDiff(root: string, baseSha: string, headSha: string): Promise<string> {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('Invalid review.')
  await assertSafeRepo(root)
  return git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', baseSha, headSha])
}

/**
 * Apply exactly the reviewed change to the base branch as one commit (your git identity), then delete
 * the task branch. Uses the recorded commits, so later changes to the branch can't sneak in.
 */
export async function mergeTaskBranch(root: string, base: string, branch: string, headSha: string, message: string): Promise<void> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha)) throw new Error('Invalid review.')
  const ready = await prepareTaskBase(root).catch((e: Error) => {
    throw new Error(`Can't merge yet: ${e.message}`)
  })
  if (ready.base !== base) await git(root, ['checkout', base])
  const branchTip = (await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim()
  if (branchTip && branchTip !== headSha) throw new Error('The task branch changed after it was reviewed. Discard it, or look at it in the Changes tab.')
  await git(root, ['merge', '--squash', headSha])
  const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
  await git(root, [...identity, 'commit', '--no-verify', '-m', message.slice(0, 200)])
  await git(root, ['branch', '-D', branch]).catch(() => undefined)
}

export async function deleteTaskBranch(root: string, branch: string): Promise<void> {
  assertTaskBranch(branch)
  await assertSafeRepo(root)
  if ((await currentBranch(root)) === branch) throw new Error('Switch back to your main branch before discarding this one.')
  await git(root, ['branch', '-D', branch])
}

/** Check out a branch (a task branch to try it in Studio, or back to the base). Requires a clean tree. */
export async function checkoutBranch(root: string, branch: string): Promise<void> {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid branch name.')
  const status = await gitStatus(root)
  if (status.files.length > 0) throw new Error('There are uncommitted changes. Commit or discard them first.')
  await git(root, ['checkout', branch])
}

/** Check a task branch out into a separate temporary folder (for building it without touching your project folder). */
export async function addTempWorktree(root: string, sha: string, dir: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error('Invalid review.')
  await assertSafeRepo(root)
  await git(root, ['worktree', 'add', '--detach', dir, sha])
}

/** Paths in a commit that are symlinks or submodules (they could pull in files from outside the project). */
export async function linksInCommit(root: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) throw new Error('Invalid review.')
  const out = await git(root, ['ls-tree', '-r', '-z', '--full-tree', sha])
  return out
    .split('\0')
    .filter(Boolean)
    .filter((e) => e.startsWith('120000 ') || e.startsWith('160000 '))
    .map((e) => e.slice(e.indexOf('\t') + 1))
}

export async function removeTempWorktree(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
  await git(root, ['worktree', 'prune']).catch(() => undefined)
}
