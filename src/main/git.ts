import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GitFile, GitHubLink, GitStatus } from '@shared/types'
import { isInsideRoot } from './pathScope'
import { minimalEnv } from './env'

/**
 * A hooks folder that can never exist, so git finds no hooks to run — and that nothing (including an
 * agent that reads this value from its environment) can create: on macOS/Linux it's inside /dev/null;
 * on Windows it's inside a regular file in Hangar's data folder (a file can't contain folders), which
 * agents can't write to. See setNoHooksBase.
 */
let NO_HOOKS_DIR = process.platform === 'win32' ? join(tmpdir(), `hangar-no-hooks-${randomUUID()}`, 'hooks') : '/dev/null/hangar-no-hooks'

/** On Windows, call once at startup with Hangar's data folder. */
export function setNoHooksBase(dataDir: string): void {
  if (process.platform !== 'win32') return
  const blocker = join(dataDir, 'no-hooks')
  try {
    if (!existsSync(blocker) || !statSync(blocker).isFile()) {
      rmSync(blocker, { recursive: true, force: true })
      writeFileSync(blocker, 'This file stops git hooks from running. Do not replace it with a folder.\n')
    }
    NO_HOOKS_DIR = join(blocker, 'hooks')
    FORCED_CONFIG[1] = ['core.hooksPath', NO_HOOKS_DIR]
  } catch {
    // keep the temp-based default
  }
}

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

/**
 * Notes merge by keeping both sides' lines (git's built-in union merge): two tasks that each tick off a roadmap item
 * or add a decision no longer clash, which used to cost an AI run per merge. Code merges as usual, and so do the
 * files that tell agents what to do (CLAUDE.md, .claude/). Only the built-in drivers can be named here.
 */
const NOTE_MERGE_ATTRIBUTES = '*.md merge=union\n*.MD merge=union\nCLAUDE.md merge\n.claude/** merge\n'
let noteMergeFile: string | null = null
function noteMergeConfig(): string[] {
  if (!noteMergeFile || !existsSync(noteMergeFile)) {
    noteMergeFile = join(mkdtempSync(join(tmpdir(), 'hangar-merge-')), 'attributes')
    writeFileSync(noteMergeFile, NOTE_MERGE_ATTRIBUTES, 'utf8')
  }
  return ['-c', `core.attributesFile=${noteMergeFile}`]
}

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
function git(cwd: string, args: string[], opts: { okExitCodes?: number[]; network?: boolean } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Minimal environment: no tokens, and no GIT_DIR/GIT_WORK_TREE or similar from the user's shell.
    const env: Record<string, string> = { ...minimalEnv(), ...gitSafetyEnv() }
    // Talking to GitHub needs your sign-in, which git keeps in a credential helper that is often set in the
    // system config (the macOS keychain, Git Credential Manager on Windows). That config is yours, not the repo's.
    if (opts.network) delete env.GIT_CONFIG_NOSYSTEM
    const timeout = opts.network ? NETWORK_TIMEOUT_MS : 0
    execFile('git', args, { cwd, env, maxBuffer: 20 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : null
      if (err && (err as { killed?: boolean }).killed) reject(new Error('git timed out'))
      else if (err && !(code !== null && opts.okExitCodes?.includes(code))) reject(new Error((stderr || err.message).trim()))
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

/** Files git couldn't merge (both sides changed them): status codes DD, AU, UD, UA, DU, AA, UU. */
export function conflictedFiles(files: GitFile[]): string[] {
  return files.filter((f) => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(f.status)).map((f) => f.path)
}

/** Never commit a half-finished merge: its files hold conflict markers (<<<<<<<), which would break the game. */
function assertNoConflicts(files: GitFile[]): void {
  const c = conflictedFiles(files)
  if (c.length) {
    throw new Error(
      `A merge was left half-finished, with conflicts in ${c.slice(0, 4).join(', ')}${c.length > 4 ? '…' : ''}. Discard those files in the Changes tab (or fix them by hand) first.`
    )
  }
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
  /^core\.(fsmonitor|hookspath|pager|editor|sshcommand|askpass|gitproxy|worktree|alternaterefscommand)$/,
  /^credential(\..+)?\.helper$/,
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

/**
 * The repository must be exactly this project folder: not a subfolder of a bigger repository, and not
 * one whose config points its working tree (or git folder) somewhere else — otherwise "git add -A" or a
 * checkout could reach files outside the project.
 */
const realPath = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** Task copies Hangar made itself (folder → the game folder whose repository they belong to). */
const taskCopies = new Map<string, string>()

/** Let git run in a task's copy of the game: its git data must be the game's own (.git/worktrees/...). */
export function trustTaskCopy(dir: string, root: string): void {
  taskCopies.set(realPath(dir).toLowerCase(), root)
}

async function assertRepoIsProject(root: string): Promise<void> {
  const real = realPath
  const owner = taskCopies.get(real(root).toLowerCase())
  if (owner) {
    // A copy Hangar made: a worktree whose git data sits inside the game's own .git folder, nowhere else.
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const mainGit = join(real(owner), '.git')
    if (real(top).toLowerCase() !== real(root).toLowerCase() || real(common).toLowerCase() !== mainGit.toLowerCase() || !isInsideRoot(join(mainGit, 'worktrees'), real(gitDir))) {
      throw new Error(`This copy of the game isn't one Hangar can trust (${gitDir}), so Hangar won't run git here.`)
    }
    return
  }
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  if (real(top).toLowerCase() !== real(root).toLowerCase()) {
    throw new Error(`This folder is part of a bigger git repository (${top}). Add that repository's top folder to Hangar instead, so git never touches files outside the project.`)
  }
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
  if (!isInsideRoot(root, gitDir)) throw new Error(`This repository keeps its git data outside the project (${gitDir}), so Hangar won't run git here.`)
}

async function assertSafeRepo(root: string): Promise<void> {
  const bad = await dangerousGitConfig(root)
  if (bad.length) {
    throw new Error(
      `This repository's git config can make git run other programs, so Hangar won't run git here:\n${bad.join('\n')}\nReview .git/config and remove these entries if you didn't add them.`
    )
  }
  await assertRepoIsProject(root)
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
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
  ])
  return { isRepo: true, branch: branchOut.trim() || null, files: parsePorcelain(statusOut) }
}

export async function gitDiff(root: string, file?: string): Promise<string> {
  if (file) assertInside(root, file)
  await assertSafeRepo(root)
  const safe = DIFF_FLAGS
  // Against the last commit (staged and unstaged together). A repo with no commits yet is compared with the
  // empty tree. "--" always separates revisions from paths, so a file named HEAD can't change what's compared.
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).then(
    () => true,
    () => false
  )
  const base = hasHead ? 'HEAD' : await emptyTree(root)
  let tracked = await git(root, [...DIFF_CONFIG, 'diff', ...safe, base, '--', ...(file ? [file] : [])])
  // Show untracked files as additions so new files are reviewable too.
  const status = await gitStatus(root)
  const untracked = status.files.filter((f) => f.status === '??' && (!file || f.path === file))
  for (const f of untracked.slice(0, MAX_UNTRACKED_DIFFS)) {
    // `--no-index` exits with 1 when the files differ, which is always the case here.
    let add = await git(root, [...DIFF_CONFIG, 'diff', ...safe, '--no-index', '--', devNull(), f.path], { okExitCodes: [1] }).catch(
      (e: Error) => `(could not diff ${f.path}: ${e.message})`
    )
    // A real diff against nothing always prints a header; empty output means git couldn't (a nested repository, say).
    if (!add.trim()) add = `(could not diff ${f.path}: ${f.path.endsWith('/') ? 'it is a separate git repository' : 'git printed nothing'})\n`
    tracked += add.endsWith('\n') ? add : add + '\n'
  }
  if (untracked.length > MAX_UNTRACKED_DIFFS) {
    tracked += `(${untracked.length - MAX_UNTRACKED_DIFFS} more new files not shown here; pick one from the list to see it)\n`
  }
  return tracked
}

/**
 * Pinned so the window's diff reader always gets the same shape, whatever the user's git config says:
 * a/ b/ prefixes (diff.mnemonicPrefix, noprefix), plain rename detection (diff.renames=copies would show new
 * files as copies), and submodules as one line (diff.submodule=log would print them as loose text).
 */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', '--submodule=short', '--ignore-submodules=none']
/**
 * Unusual characters in paths always come escaped and quoted (core.quotePath=false would pass them raw), and
 * file names are taken literally: a file called "*.lua" is that file, not a pattern for every .lua file.
 */
const DIFF_CONFIG = ['--literal-pathspecs', '-c', 'core.quotePath=true']
/** New files are diffed one by one; past this many, the rest are listed as a note. */
const MAX_UNTRACKED_DIFFS = 50

/** The empty tree's id for this repo's hash format (to diff a repo that has no commits yet). */
async function emptyTree(root: string): Promise<string> {
  const format = (await git(root, ['rev-parse', '--show-object-format']).catch(() => 'sha1')).trim()
  return format === 'sha256' ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

export async function gitCommit(root: string, message: string): Promise<void> {
  const msg = message.trim()
  if (!msg) throw new Error('Commit message is empty.')
  assertNoConflicts((await gitStatus(root)).files) // also refuses dangerous config
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

/** A brand-new project: git repository on "main" with everything committed (your identity, or "Hangar"). */
export async function gitInitialCommit(root: string, message: string): Promise<void> {
  await git(root, ['init'])
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await assertSafeRepo(root)
  await git(root, ['add', '-A'])
  const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
  await git(root, [...identity, 'commit', '--no-verify', '-m', message.slice(0, 200)])
}

/**
 * Commit one file Hangar wrote (approved research) on the current branch, leaving anything else
 * uncommitted alone. Refuses on a task branch, so it can't end up inside an agent's change.
 */
/** Commit just these files on the current (non-task) branch, leaving anything else uncommitted alone. */
export async function commitFiles(root: string, files: string[], message: string): Promise<void> {
  for (const f of files) assertInside(root, f)
  await assertSafeRepo(root)
  const branch = await currentBranch(root)
  if (branch === null) return
  if (branch.startsWith('hangar/')) throw new Error(`You're on a task branch (${branch}). Switch back to your main branch first.`)
  if (!files.length) return
  await git(root, ['add', '--', ...files])
  const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
  await git(root, [...identity, 'commit', '--no-verify', '--only', '-m', message.slice(0, 200), '--', ...files])
  await noteHangarCommit(root)
}

/** The current branch and its latest commit, for publishing what's merged (never a task branch). */
export async function publishTarget(root: string): Promise<{ branch: string; sha: string; uncommitted: number }> {
  const status = await gitStatus(root) // refuses dangerous config
  if (!status.isRepo) throw new Error('This game isn\'t a git repository.')
  const branch = await currentBranch(root)
  if (!branch) throw new Error('Make a first commit before publishing.')
  if (branch.startsWith(BRANCH_PREFIX)) throw new Error(`The game folder is on a task branch (${branch}); only merged work is published.`)
  const sha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  return { branch, sha, uncommitted: status.files.length }
}

export async function commitFile(root: string, file: string, message: string): Promise<void> {
  assertInside(root, file)
  await assertSafeRepo(root)
  const branch = await currentBranch(root)
  if (branch === null) {
    // A repo with no commits yet: leave the file uncommitted.
    return
  }
  if (branch.startsWith('hangar/')) throw new Error(`You're on a task branch (${branch}). Switch back to your main branch first.`)
  await git(root, ['add', '--', file])
  const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
  await git(root, [...identity, 'commit', '--no-verify', '--only', '-m', message.slice(0, 200), '--', file])
  await noteHangarCommit(root)
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
    // The full name, shortened here: "--short" gives "heads/main" when a tag is also called "main".
    const ref = (await git(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
    if (!name) return null
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
  /** Git-ignored files when the task started (path → size:mtime), or null if there were too many to track. */
  ignored: Record<string, string> | null
}

const MAX_IGNORED = 200_000

/** Fingerprints of every git-ignored file (they never show up in a diff, so they're checked separately). */
async function ignoredFiles(root: string): Promise<Record<string, string> | null> {
  const out = await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
  const list = out.split('\0').filter(Boolean)
  if (list.length > MAX_IGNORED) return null
  const map: Record<string, string> = {}
  for (const rel of list) {
    try {
      const st = lstatSync(join(root, rel))
      map[rel] = st.isSymbolicLink() ? 'link' : `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      // vanished meanwhile
    }
  }
  return map
}

/**
 * Ignored files the task created or changed (Packages/, node_modules/, build output, .env…) would
 * otherwise stay in your project after switching back, unreviewed. Move them out to `quarantineDir`.
 */
async function quarantineIgnored(root: string, before: Record<string, string> | null, quarantineDir: string): Promise<{ moved: string[]; failed: string[]; skipped: boolean }> {
  if (before === null) return { moved: [], failed: [], skipped: true }
  const after = await ignoredFiles(root)
  if (after === null) return { moved: [], failed: [], skipped: true }
  const moved: string[] = []
  const failed: string[] = []
  for (const [rel, print] of Object.entries(after)) {
    if (before[rel] === print) continue
    const src = join(root, rel)
    // Never follow a planted link out of the project while moving.
    if (!isInsideRoot(root, dirname(src))) {
      failed.push(rel)
      continue
    }
    try {
      const st = lstatSync(src)
      if (st.isSymbolicLink()) {
        rmSync(src, { force: true })
      } else {
        const dest = join(quarantineDir, rel)
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(src, dest)
        rmSync(src, { force: true })
      }
      moved.push(rel)
    } catch {
      // leave it; it's listed as not moved
      failed.push(rel)
    }
  }
  return { moved, failed, skipped: false }
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
  return { base, baseSha, refs: await snapshotRefs(root), ignored: await ignoredFiles(root) }
}

/**
 * Continue an earlier task's branch (a follow-up message in the same conversation): the same checks as a new task,
 * then back onto that branch at the commit its review holds. The review keeps its original starting point.
 */
export async function resumeTaskBranch(root: string, branch: string, headSha: string, base: string, baseSha: string): Promise<TaskBase> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha) || !SHA.test(baseSha)) throw new Error('Invalid review.')
  const from = await prepareTaskBase(root)
  const tip = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim()
  if (tip !== headSha) throw new Error('That change\'s branch moved since it was reviewed.')
  await git(root, ['checkout', branch])
  return { ...from, base, baseSha }
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
 * A task's own copy of the game: its new branch, from the base's commit, checked out in a folder of its own, so the
 * game folder never switches branches and several tasks can run at once. Anything left in `dir` is cleared first.
 */
export async function startTaskWorktree(root: string, dir: string, branch: string, from: TaskBase): Promise<void> {
  assertTaskBranch(branch)
  if (!SHA.test(from.baseSha)) throw new Error('Invalid starting point.')
  await clearWorktreeDir(root, dir)
  await assertSafeRepo(root)
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, from.baseSha])
  trustTaskCopy(dir, root)
}

/** An existing task branch (a follow-up in the same conversation, or a clash to fix) in its own folder again. */
export async function resumeTaskWorktree(root: string, dir: string, branch: string, headSha: string): Promise<void> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha)) throw new Error('Invalid review.')
  const tip = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim()
  if (tip !== headSha) throw new Error('That change\'s branch moved since it was reviewed.')
  await clearWorktreeDir(root, dir)
  await assertSafeRepo(root)
  await git(root, ['worktree', 'add', '-q', dir, branch])
  trustTaskCopy(dir, root)
}

/** The game's files as git sees them in a working folder: tracked plus new ones, without what's git-ignored. */
export async function listWorkingFiles(root: string): Promise<string[]> {
  await assertSafeRepo(root)
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return [...new Set(out.split('\0').filter(Boolean))]
}

/** Remove a task's copy (its branch stays). Safe to call when it's already gone. */
export async function closeTaskWorktree(root: string, dir: string): Promise<void> {
  await clearWorktreeDir(root, dir)
}

async function clearWorktreeDir(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', '--force', dir]).catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
  await git(root, ['worktree', 'prune']).catch(() => undefined)
}

/**
 * Put back any branch or tag the agent changed, created or deleted (everything except its own task
 * branch). Returns what was restored, so the user is told.
 */
/** Commits Hangar itself put on a base branch (merges, saved outside edits), so a task doesn't undo them. */
const hangarCommits = new Set<string>()
async function noteHangarCommit(root: string): Promise<void> {
  const sha = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')).trim()
  if (sha) hangarCommits.add(sha)
}

async function restoreOtherRefs(root: string, from: TaskBase, branch: string, notes: string[] = []): Promise<string[]> {
  const own = `refs/heads/${branch}`
  const base = `refs/heads/${from.base}`
  const now = await snapshotRefs(root)
  const restored: string[] = []
  // Remote-tracking refs (refs/remotes/...) only record what GitHub had at the last push or pull, which Hangar
  // updates itself (a push after a merge) while tasks run; they change nothing in the game, so they're left alone.
  // Other task branches belong to tasks running at the same time.
  const kept = (ref: string): boolean => ref === own || ref.startsWith('refs/remotes/') || ref.startsWith(`refs/heads/${BRANCH_PREFIX}`)
  for (const [ref, sha] of Object.entries(from.refs)) {
    if (kept(ref)) continue
    if (now[ref] !== sha) {
      // The base branch moving forward while tasks run in their own copies: merges Hangar made are fine. If it now
      // points at this task's own work, the agent moved it: put back. Anything else may be you: said, not undone.
      if (ref === base && now[ref] && (await git(root, ['merge-base', '--is-ancestor', sha, now[ref]!]).then(() => true, () => false))) {
        const tip = now[ref]!
        const agents = await git(root, ['merge-base', '--is-ancestor', tip, `refs/heads/${branch}`]).then(() => true, () => false)
        if (!agents) {
          if (!hangarCommits.has(tip)) notes.push(`${from.base} gained commits while this task ran that Hangar didn't make (now at ${tip.slice(0, 9)}). They were left as they are: check them if you didn't make them.`)
          continue
        }
      }
      await git(root, ['update-ref', ref, sha])
      restored.push(ref)
    }
  }
  for (const ref of Object.keys(now)) {
    if (kept(ref) || ref in from.refs || ref === 'refs/stash') continue
    await git(root, ['update-ref', '-d', ref])
    restored.push(ref)
  }
  return restored
}

/** The task branch no longer builds on where the task started: kept for you to look at, never reviewed or merged. */
export class RewrittenBranchError extends Error {}

/** A merge refused because the change and the base branch both changed the same lines. */
export class MergeClashError extends Error {
  constructor(
    message: string,
    readonly files: string[]
  ) {
    super(message)
  }
}

const hasMergeHead = (root: string): Promise<boolean> => git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)

/** Lines git writes around a conflict. */
const MARKERS = ['^<<<<<<<( |$)', '^>>>>>>>( |$)', '^\\|\\|\\|\\|\\|\\|\\|( |$)']

/**
 * Start fixing a clash: the review's branch, with the latest base branch merged in and the conflicts left in the
 * files for an agent to resolve. The task's starting point becomes the base's current commit, so once fixed, the
 * review shows (and merges) only the change on top of what's there now.
 */
export async function startClashFix(root: string, branch: string, base: string, headSha: string): Promise<{ from: TaskBase; conflicts: string[] }> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha)) throw new Error('Invalid review.')
  let from = await prepareTaskBase(root)
  if (from.base !== base) {
    await git(root, ['checkout', base])
    from = await prepareTaskBase(root)
  }
  const tip = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim()
  if (tip !== headSha) throw new Error('The change\'s branch moved since it was reviewed, so Hangar won\'t fix it automatically.')
  await git(root, ['checkout', branch])
  let conflicts: string[] = []
  try {
    await git(root, [...noteMergeConfig(), 'merge', '--no-ff', '--no-commit', from.baseSha])
  } catch (e) {
    conflicts = conflictedFiles((await gitStatus(root)).files)
    if (!conflicts.length) {
      await abortClashFix(root, branch, headSha, from.base)
      throw e
    }
  }
  return { from, conflicts }
}

/**
 * The same, in the change's own copy (`dir`): the game folder stays on the base branch throughout. If the merge fails
 * for any reason other than conflicts, the copy is removed and the branch is as it was.
 */
export async function startClashFixWorktree(root: string, dir: string, branch: string, base: string, headSha: string): Promise<{ from: TaskBase; conflicts: string[] }> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha)) throw new Error('Invalid review.')
  let from = await prepareTaskBase(root)
  if (from.base !== base) {
    await git(root, ['checkout', base])
    from = await prepareTaskBase(root)
  }
  await resumeTaskWorktree(root, dir, branch, headSha)
  let conflicts: string[] = []
  try {
    await git(dir, [...noteMergeConfig(), 'merge', '--no-ff', '--no-commit', from.baseSha])
  } catch (e) {
    conflicts = conflictedFiles((await gitStatus(dir)).files)
    if (!conflicts.length) {
      await abortClashFix(dir, branch, headSha, from.base, { worktree: true }).catch(() => undefined)
      await closeTaskWorktree(root, dir)
      throw e
    }
  }
  return { from, conflicts }
}

/** Files that still hold conflict marker lines (tracked or new, in the working folder). */
export async function filesWithMarkers(root: string): Promise<string[]> {
  const out = await git(root, ['grep', '-l', '-I', '--untracked', '-E', ...MARKERS.flatMap((m) => ['-e', m]), '--'], { okExitCodes: [1] })
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
 * Check the agent's fix and commit it as the merge. Returns why it can't be used (and changes nothing), or null when
 * it was committed. The caller then finishes the task as usual (switch back, update the review).
 */
export async function finishClashFix(root: string, branch: string, baseSha: string, agentName: string): Promise<string | null> {
  assertTaskBranch(branch)
  await assertSafeRepo(root)
  if ((await currentBranch(root)) !== branch) return 'The agent switched branches.'
  const left = await filesWithMarkers(root)
  if (left.length) return `Conflict markers are still in ${left.slice(0, 4).join(', ')}${left.length > 4 ? '…' : ''}.`
  if (await hasMergeHead(root)) {
    await git(root, ['add', '-A'])
    const who = agentName.replace(/[<>\n]/g, '').slice(0, 40)
    await git(root, ['-c', `user.name=Hangar (${who})`, '-c', 'user.email=hangar@localhost', 'commit', '--no-verify', '-m', 'Bring in the latest work and resolve the clash'])
  }
  // The fix must sit on top of the base's current work (an agent running git itself could have undone the merge).
  const onTop = await git(root, ['merge-base', '--is-ancestor', baseSha, 'HEAD']).then(() => true, () => false)
  return onTop ? null : 'The latest work from the main branch is no longer part of the change.'
}

/** Put the change's branch back exactly as it was before the fix, and the folder back on the base branch. */
export async function abortClashFix(root: string, branch: string, headSha: string, base: string, opts: { worktree?: boolean } = {}): Promise<void> {
  assertTaskBranch(branch)
  if (!SHA.test(headSha)) throw new Error('Invalid review.')
  await assertSafeRepo(root)
  if (await hasMergeHead(root)) await git(root, ['merge', '--abort']).catch(() => undefined)
  if ((await currentBranch(root)) === branch) await git(root, ['reset', '--hard', '-q', headSha])
  else await git(root, ['update-ref', `refs/heads/${branch}`, headSha])
  // A change's own copy is removed by the caller; the game folder never left the base branch.
  if (!opts.worktree) await git(root, ['checkout', base])
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
export async function finishTaskBranch(
  root: string,
  branch: string,
  from: TaskBase,
  agentName: string,
  message: string,
  quarantineDir?: string,
  opts: { recovering?: boolean; worktree?: boolean } = {}
): Promise<FinishedTask> {
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

  if (opts.recovering) {
    // Hangar was closed meanwhile: the start-of-task snapshot may be days old, and you may have committed, tagged or
    // branched since. Nothing is put back; what changed is listed instead.
    const changed = await refsChangedSince(root, from, branch)
    if (changed.length) notes.push(refsNote(changed))
  } else {
    const restored = await restoreOtherRefs(root, from, branch, notes)
    if (restored.length) notes.push(`The agent changed other branches or tags; Hangar put them back: ${restored.join(', ')}.`)
  }

  const tip = (await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim()
  const descends = await git(root, ['merge-base', '--is-ancestor', from.baseSha, tip]).then(() => true).catch(() => false)
  if (!descends) throw new RewrittenBranchError(`The task branch no longer builds on ${from.base}'s starting point (its history was rewritten). It was kept for you to inspect: ${branch}.`)

  await git(root, ['add', '-A'])
  // --ignore-submodules=none: a task that only bumps a submodule (with ignore=all configured) still gets committed and reviewed.
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z', '--ignore-submodules=none'])).split('\0').filter(Boolean)
  if (staged.length > 0 && opts.recovering) {
    notes.push(
      `Everything uncommitted in the project folder (${staged.length} file${staged.length === 1 ? '' : 's'}) was committed to this branch. That may include changes you made while Hangar was closed: look before you Discard it, which would delete them too.`
    )
  }
  if (staged.length > 0) {
    const who = agentName.replace(/[<>\n]/g, '').slice(0, 40)
    await git(root, ['-c', `user.name=Hangar (${who})`, '-c', 'user.email=hangar@localhost', 'commit', '--no-verify', '-m', message.slice(0, 200)])
  }
  const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  // In its own copy, the task's folder is simply removed afterwards (by the caller, who then deletes an empty branch).
  if (!opts.worktree) await git(root, ['checkout', from.base])
  const files = (await git(root, ['diff', '--name-only', '-z', '--ignore-submodules=none', from.baseSha, headSha, '--'])).split('\0').filter(Boolean)
  if (files.length === 0 && !opts.worktree) await git(root, ['branch', '-D', branch]).catch(() => undefined)
  if (files.some((f) => /(^|\/)\.gitignore$/.test(f))) notes.push('This change edits .gitignore — check it doesn\'t hide or expose files you care about.')
  if (opts.worktree) {
    // Git-ignored files the agent made stay in its copy, which is removed: they never reach your game folder.
  } else if (opts.recovering) {
    const note = await ignoredChangesNote(root, from.ignored ?? null)
    if (note) notes.push(note)
  } else if (quarantineDir) {
    const q = await quarantineIgnored(root, from.ignored ?? null, quarantineDir)
    if (q.moved.length) {
      notes.push(
        `The agent created or changed ${q.moved.length} git-ignored file${q.moved.length === 1 ? '' : 's'} (${q.moved.slice(0, 5).join(', ')}${q.moved.length > 5 ? '…' : ''}), which wouldn't show in this review. Hangar moved ${q.moved.length === 1 ? 'it' : 'them'} out of your project to ${quarantineDir}.`
      )
    }
    if (q.failed.length) {
      notes.push(
        `Warning: the agent also created or changed ${q.failed.length} git-ignored file${q.failed.length === 1 ? '' : 's'} that Hangar couldn't move out (${q.failed.slice(0, 5).join(', ')}${q.failed.length > 5 ? '…' : ''}). ${q.failed.length === 1 ? 'It is' : 'They are'} still in your project and not part of this review — check or delete ${q.failed.length === 1 ? 'it' : 'them'} before running the game.`
      )
    }
    if (q.skipped) notes.push('This project has too many git-ignored files for Hangar to check what the agent changed outside git.')
  }
  return { files, headSha: files.length ? headSha : null, note: notes.length ? notes.join(' ') : null }
}

const SHA = /^[0-9a-f]{40,64}$/

/** The reviewed change: exactly from the task's starting commit to the commit Hangar recorded. */
export async function reviewDiff(root: string, baseSha: string, headSha: string): Promise<string> {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('Invalid review.')
  await assertSafeRepo(root)
  return git(root, [...DIFF_CONFIG, 'diff', ...DIFF_FLAGS, baseSha, headSha, '--'])
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
  try {
    await git(root, [...noteMergeConfig(), 'merge', '--squash', headSha])
  } catch (e) {
    // The folder was clean before (prepareTaskBase), so putting it back to the last commit loses nothing but the
    // failed merge. Never leave it half-merged: a later save would commit the conflict markers.
    const conflicts = conflictedFiles((await gitStatus(root).catch(() => null))?.files ?? [])
    await git(root, ['reset', '--hard', '-q', 'HEAD'])
    if (conflicts.length) {
      throw new MergeClashError(
        `This change clashes with work already on ${base} (in ${conflicts.slice(0, 4).join(', ')}${conflicts.length > 4 ? '…' : ''}). Nothing was merged. Use Fix with AI, or discard it.`,
        conflicts
      )
    }
    throw e
  }
  // Already on the base branch exactly (an identical change merged earlier): nothing to commit.
  const changed = (await git(root, ['diff', '--cached', '--name-only'])).trim() !== ''
  if (changed) {
    const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
    try {
      await git(root, [...identity, 'commit', '--no-verify', '-m', message.slice(0, 200)])
    } catch (e) {
      await git(root, ['reset', '--hard', '-q', 'HEAD'])
      throw e
    }
    await noteHangarCommit(root)
  }
  await git(root, ['branch', '-D', branch]).catch(() => undefined)
}

/** The current branch, after checking the repo is one Hangar will run git in. */
export async function safeCurrentBranch(root: string): Promise<string | null> {
  await assertSafeRepo(root)
  return currentBranch(root)
}

/**
 * Branches and tags (not remotes) that differ from the start-of-task snapshot, other than the task's own branch,
 * each with what happened ("my-feature deleted, was abc1234"), so a deleted one can be brought back.
 */
export async function refsChangedSince(root: string, from: TaskBase, ownBranch: string): Promise<string[]> {
  const own = `refs/heads/${ownBranch}`
  const now = await snapshotRefs(root)
  const mine = (ref: string): boolean => ref !== own && (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
  const names = [...new Set([...Object.keys(from.refs), ...Object.keys(now)].filter(mine))].sort()
  const short = (sha: string | undefined): string => (sha ?? '').slice(0, 9)
  return names
    .filter((ref) => from.refs[ref] !== now[ref])
    .map((ref) => {
      const name = ref.replace(/^refs\/(heads|tags)\//, '')
      const before = from.refs[ref]
      const after = now[ref]
      return !after ? `${name} deleted (was ${short(before)})` : !before ? `${name} new (at ${short(after)})` : `${name} moved (${short(before)} → ${short(after)})`
    })
}

/** The note for refsChangedSince: nothing is put back, and how to bring back a deleted branch. */
export function refsNote(changed: string[]): string {
  const deleted = changed.some((c) => c.includes(' deleted '))
  return `Since this task started, these branches or tags changed (by the agent, or by you while Hangar was closed). Hangar left them as they are: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? '…' : ''}.${
    deleted ? ' To bring back a deleted branch: git branch <name> <the "was" commit>.' : ''
  }`
}

/** How many files have uncommitted changes in the project folder (0 if it can't tell). */
export async function uncommittedCount(root: string): Promise<number> {
  return (await gitStatus(root).catch(() => null))?.files.length ?? 0
}

/**
 * After Hangar was closed mid-task: git-ignored files that are new or changed since the task started. They may be the
 * agent's or yours (made while Hangar was closed), so they're listed for you, never moved.
 */
export async function ignoredChangesNote(root: string, before: Record<string, string> | null): Promise<string | null> {
  if (before === null) return null
  const after = await ignoredFiles(root)
  if (after === null) return null
  const changed = Object.entries(after)
    .filter(([rel, print]) => before[rel] !== print)
    .map(([rel]) => rel)
  if (!changed.length) return null
  return `${changed.length} git-ignored file${changed.length === 1 ? ' was' : 's were'} created or changed since this task started (by the agent, or by you while Hangar was closed): ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''}. ${changed.length === 1 ? "It isn't part of this review and wasn't moved" : "They aren't part of this review and weren't moved"}: check before running the game.`
}

/**
 * A task branch left behind when Hangar closed mid-task: its tip and what it changes from where the task started,
 * or null if it's gone.
 */
export async function leftoverTaskBranch(root: string, branch: string, baseSha: string): Promise<{ headSha: string; files: string[]; rewritten: boolean } | null> {
  assertTaskBranch(branch)
  if (!SHA.test(baseSha)) throw new Error('Invalid task.')
  await assertSafeRepo(root)
  const headSha = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim()
  if (!SHA.test(headSha)) return null
  // A branch that no longer builds on where the task started can't be reviewed as baseSha..headSha.
  const rewritten = !(await git(root, ['merge-base', '--is-ancestor', baseSha, headSha]).then(() => true).catch(() => false))
  const files = rewritten ? [] : (await git(root, ['diff', '--name-only', '-z', '--ignore-submodules=none', baseSha, headSha, '--'])).split('\0').filter(Boolean)
  return { headSha, files, rewritten }
}

/**
 * The project is on a task branch Hangar has no record of (it was closed mid-task before it kept records), with
 * nothing on it: no uncommitted changes, and another branch (main or master first) at the very same commit.
 * Switch to that branch and delete the empty task branch. Returns the branch switched to, or null if it wasn't
 * that safe case (then nothing is touched).
 */
export async function leaveEmptyTaskBranch(root: string): Promise<{ from: string; to: string } | null> {
  const status = await gitStatus(root) // refuses dangerous config, before anything else runs
  if (!status.isRepo || status.files.length) return null
  const branch = await currentBranch(root)
  if (!branch || !SAFE_BRANCH.test(branch)) return null
  const tip = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  // Full ref names (a tag called "main" would make the short form "heads/main").
  const same = (await git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']))
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([sha, ref]) => sha === tip && ref?.startsWith('refs/heads/'))
    .map(([, ref]) => ref!.slice('refs/heads/'.length))
    .filter((name) => !name.startsWith(BRANCH_PREFIX) && /^[A-Za-z0-9._/-]{1,120}$/.test(name) && !name.startsWith('-'))
  const to = ['main', 'master'].find((n) => same.includes(n)) ?? same[0]
  if (!to) return null
  await git(root, ['checkout', to])
  await git(root, ['branch', '-D', branch]).catch(() => undefined)
  return { from: branch, to }
}

/**
 * Gets the project folder ready before Hangar starts a task or merges, so you never manage branches yourself:
 * - left on a task branch with nothing uncommitted (a crash, an old "Try it in Studio"): back to main (or master),
 *   deleting that task branch if it holds nothing of its own;
 * - on your own branch with edits made outside Hangar (in Studio, an editor): they're saved as one commit there,
 *   so they're kept and the task can start from them.
 * A task branch with uncommitted changes is left alone (that's for you to look at). Returns what it did, for the feed.
 */
export async function tidyWorkingFolder(root: string): Promise<string[]> {
  const status = await gitStatus(root) // refuses dangerous config, before anything else runs
  if (!status.isRepo) return []
  const branch = await currentBranch(root)
  if (!branch) return []
  if (branch.startsWith(BRANCH_PREFIX)) {
    if (status.files.length) return []
    const heads = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master'])).split('\n').map((l) => l.trim())
    const to = heads.includes('refs/heads/main') ? 'main' : heads.includes('refs/heads/master') ? 'master' : null
    if (!to) return []
    await git(root, ['checkout', to])
    const own = (await git(root, ['rev-list', '--count', `refs/heads/${to}..refs/heads/${branch}`]).catch(() => '1')).trim()
    if (own === '0' && SAFE_BRANCH.test(branch)) await git(root, ['branch', '-D', branch]).catch(() => undefined)
    return [`The folder was left on ${branch}; Hangar switched it back to ${to}.`]
  }
  if (!status.files.length) return []
  assertNoConflicts(status.files)
  await git(root, ['add', '-A'])
  const identity = await git(root, ['config', 'user.email']).then(() => [] as string[]).catch(() => ['-c', 'user.name=Hangar', '-c', 'user.email=hangar@localhost'])
  await git(root, [...identity, 'commit', '--no-verify', '-m', 'Changes made outside Hangar'])
  await noteHangarCommit(root)
  const n = status.files.length
  return [`Saved ${n} change${n === 1 ? '' : 's'} made outside Hangar (in Studio or an editor) as a commit on ${branch}, so the task starts from them.`]
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
  // Hangar's own copy: git may run in it (listing its files to show it in Studio), like in a task's copy.
  trustTaskCopy(dir, root)
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

// ---------- GitHub (origin remote) ----------

/** Pushing, pulling and cloning give up after this long (a sign-in prompt that can't be shown, a dead network). */
const NETWORK_TIMEOUT_MS = 3 * 60_000

/**
 * Forced onto every command that talks to GitHub: only https and ssh, with certificate checks on, whatever the
 * repository's config says (a planted `url.*.insteadOf` can't turn a GitHub address into a local program).
 */
const NETWORK_CONFIG = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'http.sslVerify=true']

export interface GitHubRepo {
  owner: string
  name: string
  /** The address git uses: https://github.com/owner/name.git or git@github.com:owner/name.git. */
  url: string
  webUrl: string
}

/** A GitHub repository from what the user pasted (its page, the https clone link or the ssh one), else null. */
export function parseGitHubRepo(input: string): GitHubRepo | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s.length > 300 || /[\s\0]/.test(s)) return null
  const m =
    /^(?:https:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s)
  if (!m) return null
  const [, owner, name] = m as unknown as [string, string, string]
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..' || name.startsWith('-')) return null
  const ssh = s.includes('git@')
  return {
    owner,
    name,
    url: ssh ? `git@github.com:${owner}/${name}.git` : `https://github.com/${owner}/${name}.git`,
    webUrl: `https://github.com/${owner}/${name}`
  }
}

/** git's own words turned into something to do about it. */
function networkError(e: Error, action: string): Error {
  const m = e.message
  if (/ETIMEDOUT|timed out/i.test(m)) {
    return new Error(`${action} took too long and was stopped. Check your internet connection, and that git can sign in to GitHub without asking.`)
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|403/i.test(m)) {
    return new Error(
      `GitHub didn't accept your sign-in. Sign in once in a terminal with "gh auth login" (or with GitHub Desktop), check you can push to this repository, then try again.\n\n${m}`
    )
  }
  if (/Repository not found|not found|does not appear to be a git repository/i.test(m)) {
    return new Error(`GitHub couldn't find that repository, or your account can't see it.\n\n${m}`)
  }
  return new Error(`${action} failed: ${m}`)
}

async function originRepo(root: string): Promise<{ raw: string | null; repo: GitHubRepo | null }> {
  // Exit code 1 means origin has no address.
  const raw = (await git(root, ['config', '--get', 'remote.origin.url'], { okExitCodes: [1] })).trim() || null
  return { raw, repo: raw ? parseGitHubRepo(raw) : null }
}

export async function githubLink(root: string): Promise<GitHubLink> {
  const status = await gitStatus(root) // refuses repositories with dangerous config
  if (!status.isRepo) return { isRepo: false, repo: null, webUrl: null, otherRemote: null, branch: null }
  const { raw, repo } = await originRepo(root)
  return {
    isRepo: true,
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    webUrl: repo?.webUrl ?? null,
    otherRemote: raw && !repo ? raw : null,
    branch: await currentBranch(root)
  }
}

/** Point origin at a GitHub repository (adding it, or replacing what was there). Nothing is sent yet. */
export async function linkGitHub(root: string, input: string): Promise<GitHubLink> {
  const repo = parseGitHubRepo(input)
  if (!repo) throw new Error('That isn\'t a GitHub repository link. Paste one like https://github.com/you/my-game.')
  const status = await gitStatus(root)
  if (!status.isRepo) throw new Error('This project isn\'t a git repository yet. Initialize one in the Changes tab first.')
  await git(root, ['remote', (await hasRemote(root, 'origin')) ? 'set-url' : 'add', 'origin', repo.url])
  return githubLink(root)
}

async function hasRemote(root: string, name: string): Promise<boolean> {
  return (await git(root, ['remote'])).split('\n').some((r) => r.trim() === name)
}

/** Forget the link (only on this computer; the repository on GitHub is untouched). */
export async function unlinkGitHub(root: string): Promise<GitHubLink> {
  await assertSafeRepo(root)
  if (await hasRemote(root, 'origin')) await git(root, ['remote', 'remove', 'origin'])
  return githubLink(root)
}

/** The linked repository and the branch to sync, or a reason not to. */
async function syncTarget(root: string, action: string, named?: string): Promise<{ repo: GitHubRepo; branch: string }> {
  await assertSafeRepo(root)
  const { repo } = await originRepo(root)
  if (!repo) throw new Error(`Link a GitHub repository first, then ${action}.`)
  const branch = named ?? (await currentBranch(root))
  if (!branch) throw new Error('Make a first commit in the Changes tab first.')
  if (branch.startsWith(BRANCH_PREFIX)) throw new Error(`You're on a task branch (${branch}). Switch back to your main branch first; unreviewed work is never sent to GitHub.`)
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.startsWith('-')) throw new Error(`Hangar can't sync a branch named ${branch}.`)
  return { repo, branch }
}

/**
 * Send the current branch's commits to the same branch on GitHub. Never forces: if GitHub has commits this
 * copy doesn't, it stops and asks you to pull. Uncommitted changes and task branches stay on this computer.
 */
export async function pushToGitHub(root: string, named?: string): Promise<{ repo: string; branch: string }> {
  const { repo, branch } = await syncTarget(root, 'push', named)
  try {
    await git(root, [...NETWORK_CONFIG, 'push', '--no-verify', repo.url, `refs/heads/${branch}:refs/heads/${branch}`], { network: true })
  } catch (e) {
    const m = (e as Error).message
    if (/non-fast-forward|fetch first|rejected/i.test(m)) {
      throw new Error(`GitHub's ${branch} has commits this copy doesn't have. Pull first, then push again.`)
    }
    throw networkError(e as Error, 'Pushing to GitHub')
  }
  // Remember what GitHub now has, so plain git (and the Changes tab) can tell what's not pushed yet.
  await git(root, ['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]).catch(() => undefined)
  return { repo: `${repo.owner}/${repo.name}`, branch }
}

/**
 * Bring in commits from the same branch on GitHub, only when that's a plain fast-forward (no merges, so nothing
 * of yours is rewritten or mixed), and only with no uncommitted changes.
 */
export async function pullFromGitHub(root: string): Promise<{ repo: string; branch: string; commits: number }> {
  const { repo, branch } = await syncTarget(root, 'pull')
  const status = await gitStatus(root)
  if (status.files.length > 0) throw new Error('There are uncommitted changes. Commit or discard them in the Changes tab first.')
  try {
    await git(root, [...NETWORK_CONFIG, 'fetch', '--no-tags', '--no-recurse-submodules', repo.url, `refs/heads/${branch}`], { network: true })
  } catch (e) {
    if (/couldn't find remote ref/i.test((e as Error).message)) throw new Error(`GitHub doesn't have a ${branch} branch yet. Push first.`)
    throw networkError(e as Error, 'Pulling from GitHub')
  }
  const fetched = (await git(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim()
  if (!SHA.test(fetched)) throw new Error('Pulling from GitHub failed: no commit came back.')
  const commits = Number((await git(root, ['rev-list', '--count', `HEAD..${fetched}`])).trim()) || 0
  if (commits > 0) {
    const ff = await git(root, ['merge-base', '--is-ancestor', 'HEAD', fetched]).then(() => true).catch(() => false)
    if (!ff) {
      throw new Error(
        `This copy and GitHub's ${branch} have both changed since they last matched. Hangar only pulls when nothing needs merging; sort it out with git or GitHub Desktop.`
      )
    }
    await git(root, ['merge', '--ff-only', '--no-verify', fetched])
  }
  await git(root, ['update-ref', `refs/remotes/origin/${branch}`, fetched]).catch(() => undefined)
  return { repo: `${repo.owner}/${repo.name}`, branch, commits }
}

/**
 * Download a GitHub repository into `dest` (which must not exist yet, or be empty). Submodules aren't fetched.
 * The result is treated like any folder you open: its .mcp.json, roles and git config are checked before use.
 */
export async function cloneGitHub(input: string, dest: string): Promise<GitHubRepo> {
  const repo = parseGitHubRepo(input)
  if (!repo) throw new Error('That isn\'t a GitHub repository link. Paste one like https://github.com/you/my-game.')
  try {
    await git(dirname(dest), [...NETWORK_CONFIG, 'clone', '--no-recurse-submodules', '--origin', 'origin', '--', repo.url, dest], { network: true })
  } catch (e) {
    throw networkError(e as Error, 'Downloading from GitHub')
  }
  await assertSafeRepo(dest)
  return repo
}
