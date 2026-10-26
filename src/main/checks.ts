import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { CheckResult, Project, Review, ReviewChecks } from '@shared/types'
import { revealHidden } from '@shared/text'
import { buildAgentEnv } from './agentRunner'
import { addTempWorktree, linksInCommit, removeTempWorktree } from './git'
import { isProtectedPath } from './pathScope'
import { shellWords } from './permissions'
import { resolveCommand, unsafeRojoPaths, uploadPlace, type KeySource } from './testPlace'
import { cleanLuauTests, CLOUD_CHECK_NAME, hasChecks, LUNE_CHECK_NAME, LUNE_RUNNER, LUNE_RUNNER_FILE, openCloudApi, runOnTestPlace, type CloudApi } from './luauTests'
import { realTool } from './studioSync'
import { CREDENTIAL_DIRS } from './sandbox'

/**
 * "Definition of done": the commands you list in the Project tab (lint, format check, build, tests)
 * run on every finished autonomous task before you merge it.
 *
 * Where and how they run:
 * - In a temporary separate checkout of the task's exact final commit, inside Hangar's data folder.
 *   Your project folder and the next task are untouched.
 * - Without a shell: each command is plain words, and the program is found on your PATH (never in the
 *   checkout, so a branch can't ship its own "selene").
 * - With a minimal environment (no tokens or keys), a time limit, and output capped.
 *
 * - On macOS and Linux (with the project's sandbox on), inside the OS sandbox: no network, writes only
 *   to the checkout and temp, and no reading your credential folders or Hangar's data. Windows has no
 *   sandbox, so there checks run with your permissions (the review says so).
 *
 * Skipped (and Merge then asks you to confirm) when the task changed files that decide what runs —
 * toolchain manifests like rokit.toml, package.json, editor/CI config, JavaScript tool config that is
 * itself code (eslint/prettier configs, tsconfig plugins) — or added programs or scripts that Windows
 * could pick up from the current folder, symlinks or submodules. Those need your eyes first.
 */
const TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT = 4000

export const SUGGESTED_CHECKS = [
  { name: 'Format', command: 'stylua --check src' },
  { name: 'Lint', command: 'selene src' },
  { name: 'Build', command: 'rojo build -o hangar-check.rbxl' }
]

/** Remove terminal colour codes and keep the end of the output, where the errors usually are. */
export function tidyOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n').trim()
  return plain.length > MAX_OUTPUT ? '…\n' + plain.slice(-MAX_OUTPUT) : plain
}

interface Ran {
  code: number | null
  output: string
  error: string | null
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}
const expand = (p: string, home: string): string => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
const sbString = (p: string): string => JSON.stringify(p)
/** Every folder above `p`, up to the root. */
const ancestors = (p: string): string[] => {
  const out: string[] = []
  for (let cur = dirname(p); cur !== dirname(cur); cur = dirname(cur)) out.push(cur)
  out.push(dirname(p) === p ? p : '/')
  return [...new Set(out)]
}

/**
 * Wrap a command in the OS sandbox. Returns null when the sandbox isn't available.
 * macOS: sandbox-exec with a profile that denies network, writes outside the checkout and temp, and
 * reads of credential folders and Hangar's data (except the checkout inside it).
 * Linux: bubblewrap with a read-only root, the checkout writable, private /tmp, no network.
 */
export function sandboxCommand(
  platform: NodeJS.Platform,
  program: string,
  args: string[],
  opts: { work: string; appDataDir: string; home?: string; env?: NodeJS.ProcessEnv }
): { file: string; argv: string[] } | null {
  const home = opts.home ?? homedir()
  const work = real(opts.work)
  const secrets = [...CREDENTIAL_DIRS.map((d) => expand(d, home)), opts.appDataDir]
  if (platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) return null
    const tmp = real(tmpdir())
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny file-write*)',
      `(allow file-write* (subpath ${sbString(work)}) (subpath ${sbString(tmp)}) (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null") (regex #"^/dev/tty"))`,
      ...secrets.map((d) => `(deny file-read* (subpath ${sbString(real(d))}))`),
      `(allow file-read* (subpath ${sbString(work)}))`,
      // The checkout sits inside Hangar's (unreadable) data folder. Tools like Rojo look up each folder above where
      // they run (resolving paths), so those folders' own details, never their contents or listings, stay readable.
      ...ancestors(work).map((p) => `(allow file-read-metadata (literal ${sbString(p)}))`)
    ].join('\n')
    return { file: '/usr/bin/sandbox-exec', argv: ['-p', profile, program, ...args] }
  }
  if (platform === 'linux') {
    const bwrap = resolveCommand('bwrap', opts.env ?? process.env, platform)
    if (!bwrap) return null
    const argv = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
    for (const d of secrets) {
      if (!existsSync(d)) continue
      argv.push(...(d === opts.appDataDir || !/\.(netrc|npmrc|pypirc|git-credentials)$/.test(d) ? ['--tmpfs', d] : ['--ro-bind', '/dev/null', d]))
    }
    argv.push('--bind', work, work, '--chdir', work, '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session', program, ...args)
    return { file: bwrap, argv }
  }
  return null
}

function runOne(program: string, args: string[], cwd: string, platform: NodeJS.Platform, wrap: { file: string; argv: string[] } | null): Promise<Ran> {
  // Windows can't start .cmd/.bat files directly. The words are plain (no quotes or metacharacters),
  // so passing them through cmd.exe can't change what runs.
  const isBatch = !wrap && platform === 'win32' && /\.(cmd|bat)$/i.test(program)
  const file = wrap ? wrap.file : isBatch ? (process.env.ComSpec ?? 'cmd.exe') : program
  const argv = wrap ? wrap.argv : isBatch ? ['/d', '/s', '/c', `"${program}" ${args.join(' ')}`] : args
  // Never let Windows (cmd.exe, or Node starting "node"/"git" by name) pick a program from the checkout.
  const env = { ...buildAgentEnv({}), NoDefaultCurrentDirectoryInExePath: '1' }
  return new Promise((resolveRun) => {
    execFile(
      file,
      argv,
      { cwd, env, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 5 * 1024 * 1024, windowsVerbatimArguments: isBatch },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`
        if (!err) return resolveRun({ code: 0, output, error: null })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
        if (e.killed) return resolveRun({ code: null, output, error: `Timed out after ${TIMEOUT_MS / 60000} minutes.` })
        if (typeof e.code === 'number') return resolveRun({ code: e.code, output, error: null })
        resolveRun({ code: null, output, error: e.message })
      }
    )
  })
}

/**
 * Files that are code to the tools a check might run: JS tool configs execute when the tool loads
 * them, tsconfig can name transformer plugins, and program/script files at any path can be picked up
 * on Windows by name from the current folder.
 */
const RUNS_AS_CODE = [
  /(^|\/)[^/]*\.config\.(c|m)?(j|t)s$/i,
  /(^|\/)\.(eslintrc|prettierrc|babelrc|stylelintrc|swcrc|mocharc|lintstagedrc)(\.[a-z]+)?$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)(jest|vitest|vite|webpack|rollup|babel|postcss|tailwind)\.config/i,
  /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|wsf|wsh|msc|scr|pif|cpl|hta|jse|lnk)$/i,
  /(^|\/)(node|git|rojo|selene|stylua|lune|luau|rokit|aftman|foreman|wally|npm|npx|python|sh|bash|pwsh|powershell)$/i
]

export function runsAsCode(file: string): boolean {
  return RUNS_AS_CODE.some((re) => re.test(file))
}

/** Why checks shouldn't run automatically on this change, or null. */
export async function checksBlockedReason(project: Project, review: Review): Promise<string | null> {
  const risky = review.files.filter((f) => isProtectedPath(f, project.path) || runsAsCode(f))
  if (risky.length) {
    return `Not run automatically: this task changed ${risky.slice(0, 4).join(', ')}${risky.length > 4 ? '…' : ''}, which can change what the check commands run. Look at the change first.`
  }
  const links = await linksInCommit(project.path, review.headSha)
  if (links.length) return `Not run automatically: the branch contains symlinks or submodules (${links.slice(0, 3).join(', ')}).`
  return null
}

export interface CheckOptions {
  workDir: string
  appDataDir: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** Open Cloud keys for the test-place Luau tests (they stay in this process). */
  keys?: KeySource
  /** Settings → Roblox's Rojo command. */
  rojoCommand?: string
  /** The Open Cloud calls for a project's test place (tests pass a fake). */
  cloud?: (place: { universeId: string; placeId: string }, apiKey: string) => CloudApi
  pollMs?: number
}

const MAX_PLACE_BYTES = 100 * 1024 * 1024

export async function runChecks(project: Project, review: Review, opts: CheckOptions): Promise<ReviewChecks | null> {
  const checks = project.settings.checks
  const luau = cleanLuauTests(project.settings.luauTests)
  if (!hasChecks(project.settings) || review.kind === 'research') return null
  const platform = opts.platform ?? process.platform
  const blocked = await checksBlockedReason(project, review)
  if (blocked) return { status: 'skipped', reason: blocked, results: [] }
  const wantSandbox = project.settings.sandbox && (platform === 'darwin' || platform === 'linux')

  mkdirSync(opts.workDir, { recursive: true })
  const work = mkdtempSync(join(opts.workDir, 'check-'))
  const tree = join(work, 'tree')
  const results: CheckResult[] = []
  try {
    await addTempWorktree(project.path, review.headSha, tree)
    for (const check of checks) {
      const started = Date.now()
      const words = shellWords(check.command)
      // Rojo, Selene and StyLua run as the official version you installed, not through a Rokit launcher (which needs
      // the branch to list them, and would run whatever its manifest names).
      const found = words ? resolveCommand(words[0]!, opts.env ?? process.env, platform) : null
      const program = words ? (realTool(words[0]!, found, opts.home, platform) ?? found) : null
      if (!words || !program) {
        results.push({
          name: check.name,
          command: check.command,
          status: 'error',
          output: words ? `Couldn't find "${words[0]}" on your PATH.` : 'Commands must be plain words (no quotes, variables or chaining).',
          ms: 0
        })
        continue
      }
      const wrap = wantSandbox ? sandboxCommand(platform, program, words.slice(1), { work, appDataDir: opts.appDataDir, home: opts.home, env: opts.env }) : null
      if (wantSandbox && !wrap) {
        results.push({
          name: check.name,
          command: check.command,
          status: 'error',
          output: platform === 'linux' ? 'The sandbox (bubblewrap) is not installed, so the check did not run.' : 'The sandbox is not available, so the check did not run.',
          ms: 0
        })
        continue
      }
      const ran = await runOne(program, words.slice(1), tree, platform, wrap)
      results.push({
        name: check.name,
        command: check.command,
        status: ran.error ? 'error' : ran.code === 0 ? 'passed' : 'failed',
        output: tidyOutput(ran.error ? `${ran.error}\n${ran.output}` : ran.output),
        ms: Date.now() - started
      })
    }
    const ctx = { project, tree, work, platform, wantSandbox, opts }
    if (luau.lune) results.push(await runLuneTests(ctx))
    if (luau.testPlace) results.push(await runTestPlaceTests(ctx))
    return { status: 'done', reason: null, results, sandboxed: wantSandbox }
  } catch (err) {
    return { status: 'done', reason: `Couldn't prepare a checkout to run checks: ${err instanceof Error ? err.message : String(err)}`, results }
  } finally {
    await removeTempWorktree(project.path, tree)
    rmSync(work, { recursive: true, force: true })
  }
}

interface LuauContext {
  project: Project
  tree: string
  work: string
  platform: NodeJS.Platform
  wantSandbox: boolean
  opts: CheckOptions
}

/** Every *.spec.luau (but *.cloud.spec.luau) in the checkout, run by Hangar's own runner with Lune, in the sandbox. */
async function runLuneTests({ tree, work, platform, wantSandbox, opts }: LuauContext): Promise<CheckResult> {
  const command = `lune run ${LUNE_RUNNER_FILE}`
  const error = (output: string): CheckResult => ({ name: LUNE_CHECK_NAME, command, status: 'error', output, ms: 0 })
  // Tests execute game code (and Lune can reach files, processes and the network), so never without the sandbox.
  if (!wantSandbox) {
    return error(
      platform === 'win32'
        ? "Lune tests run game code, so they only run inside the OS sandbox, which Windows doesn't have. Use the test place tests instead."
        : "Lune tests run game code, so they only run with this project's sandbox on."
    )
  }
  const program = realTool('lune', resolveCommand('lune', opts.env ?? process.env, platform), opts.home, platform)
  if (!program) return error('Couldn\'t find "lune" on your PATH. Install Lune (for example: rokit add --global lune-org/lune), then run the checks again.')
  const args = ['run', LUNE_RUNNER_FILE]
  const wrap = sandboxCommand(platform, program, args, { work, appDataDir: opts.appDataDir, home: opts.home, env: opts.env })
  if (!wrap) return error('The sandbox is not available, so the Lune tests did not run.')
  const started = Date.now()
  // The checkout is Hangar's temporary copy (symlinks were refused), so writing the runner here can't reach anywhere else.
  writeFileSync(join(tree, LUNE_RUNNER_FILE), LUNE_RUNNER, 'utf8')
  const ran = await runOne(program, args, tree, platform, wrap)
  return {
    name: LUNE_CHECK_NAME,
    command,
    status: ran.error ? 'error' : ran.code === 0 ? 'passed' : 'failed',
    output: revealHidden(tidyOutput(ran.error ? `${ran.error}\n${ran.output}` : ran.output)),
    ms: Date.now() - started
  }
}

/** Build the branch with Rojo (sandboxed), upload it as a saved version of the test place and run the smoke test there. */
async function runTestPlaceTests({ project, tree, work, platform, wantSandbox, opts }: LuauContext): Promise<CheckResult> {
  const command = 'rojo build, then Open Cloud Luau execution on the test place'
  const result = (status: CheckResult['status'], output: string, ms = 0): CheckResult => ({ name: CLOUD_CHECK_NAME, command, status, output, ms })
  const place = project.settings.testPlace
  if (!place) return result('error', "Set this project's test place (universe and place IDs) in the Project tab first.")
  const apiKey = opts.keys?.get(project.id) ?? null
  if (!apiKey) return result('error', 'Add a Roblox Open Cloud API key for this project in the Project tab first.')
  const rojoCmd = opts.rojoCommand || 'rojo'
  const rojo = realTool('rojo', resolveCommand(rojoCmd, opts.env ?? process.env, platform), opts.home, platform)
  if (!rojo) return result('error', `Couldn't find Rojo ("${rojoCmd}"). Install it or set its full path in Settings → Roblox.`)
  const bad = unsafeRojoPaths(tree)
  if (bad.length) return result('error', `Rojo project files point outside the project, so this branch wasn't uploaded: ${bad.slice(0, 5).join('; ')}`)

  const started = Date.now()
  const out = join(work, 'place.rbxl')
  const args = ['build', tree + sep, '-o', out]
  const wrap = wantSandbox ? sandboxCommand(platform, rojo, args, { work, appDataDir: opts.appDataDir, home: opts.home, env: opts.env }) : null
  if (wantSandbox && !wrap) return result('error', 'The sandbox is not available, so the branch was not built.')
  // Run Rojo from Hangar's folder (not the branch checkout), like publishing does.
  const built = await runOne(rojo, args, work, platform, wrap)
  if (built.error || built.code !== 0 || !existsSync(out)) {
    return result('failed', revealHidden(tidyOutput(`Rojo couldn't build this branch.\n${built.error ?? ''}\n${built.output}`)), Date.now() - started)
  }
  if (statSync(out).size > MAX_PLACE_BYTES) return result('error', 'The built place is too large to upload.', Date.now() - started)
  const api = (opts.cloud ?? defaultCloud)(place, apiKey)
  try {
    const ran = await runOnTestPlace(api, readFileSync(out), { pollMs: opts.pollMs })
    return result(ran.status, tidyOutput(ran.output), Date.now() - started)
  } catch (err) {
    return result('error', revealHidden(err instanceof Error ? err.message : String(err)), Date.now() - started)
  }
}

const defaultCloud = (place: { universeId: string; placeId: string }, apiKey: string): CloudApi =>
  openCloudApi({
    ...place,
    apiKey,
    // A saved version: what players of the test place get stays the same until you publish.
    upload: (body) => uploadPlace({ ...place, apiKey, body, versionType: 'Saved' })
  })

export { checksFailed } from '@shared/reviewRules'
