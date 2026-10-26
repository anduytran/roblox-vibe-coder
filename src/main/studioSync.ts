import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project, Review, StudioSyncState } from '@shared/types'
import { minimalEnv } from './env'
import { linkInPath } from './pathScope'
import { resolveCommand, unsafeRojoPaths } from './testPlace'
import { addTempWorktree, linksInCommit, removeTempWorktree } from './git'
import { rmSync } from 'node:fs'

/** The port the Rojo plugin in Studio connects to unless told otherwise. */
export const SYNC_PORT = 34872

/** Folders holding toolchain launchers (Rokit, Aftman, Foreman) that only work inside a project listing the tool. */
const shimDirs = (home: string): string[] => ['.rokit', '.aftman', '.foreman'].map((d) => join(home, d, 'bin'))

/** Newest version first, comparing numbers (7.10.0 before 7.7.1). */
function byVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  return 0
}

/**
 * The Rojo program to run. A real install (Homebrew, Cargo, a full path in Settings) is used as is. A Rokit/Aftman
 * launcher isn't: it only runs inside a project that lists Rojo, and it would run whatever that project's manifest
 * names. Instead Hangar runs the newest official Rojo (rojo-rbx/rojo) the toolchain has already installed.
 */
export function findRojo(command: string, home = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  return realTool('rojo', resolveCommand(command), home, platform)
}

/** Official sources of the Roblox tools Hangar runs itself (checks, sync, publishing), as Rokit/Aftman store them. */
const OFFICIAL: Record<string, [string, string]> = { rojo: ['rojo-rbx', 'rojo'], selene: ['kampfkarren', 'selene'], stylua: ['johnnymorganz', 'stylua'] }

/**
 * The real program for a tool found at `resolved`. A real install is used as is; a Rokit/Aftman launcher (which only
 * works inside a project listing the tool, and runs whatever that project's manifest names) is swapped for the newest
 * official version already installed. Tools Hangar doesn't know stay as found.
 */
export function realTool(name: string, resolved: string | null, home = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  if (resolved && !shimDirs(home).includes(dirname(resolved))) return resolved
  const source = OFFICIAL[name.toLowerCase().replace(/\.exe$/i, '')]
  if (!source) return resolved
  const exe = platform === 'win32' ? `${source[1]}.exe` : source[1]
  for (const tool of ['.rokit', '.aftman']) {
    let store: string
    try {
      // Stored with the owner's own spelling (Kampfkarren, JohnnyMorganz): matched without case.
      const base = join(home, tool, 'tool-storage')
      const owner = readdirSync(base).find((o) => o.toLowerCase() === source[0])
      const repo = owner ? readdirSync(join(base, owner)).find((r) => r.toLowerCase() === source[1]) : undefined
      if (!owner || !repo) continue
      store = join(base, owner, repo)
    } catch {
      continue
    }
    let versions: string[] = []
    try {
      versions = readdirSync(store).filter((v) => /^v?\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(v))
    } catch {
      continue
    }
    for (const v of versions.sort(byVersion)) {
      const bin = join(store, v, exe)
      try {
        if (lstatSync(bin).isFile()) return bin
      } catch {
        // not this one
      }
    }
  }
  return null
}

/** The Rojo project file to serve: default.project.json, else the only *.project.json at the top. */
export function projectFile(root: string): string | null {
  if (existsSync(join(root, 'default.project.json'))) return 'default.project.json'
  const found = readdirSync(root).filter((n) => n.endsWith('.project.json'))
  return found.length === 1 ? found[0]! : null
}

const OFF: StudioSyncState = { projectId: null, status: 'off', port: SYNC_PORT, message: null }

/**
 * Live sync of one game into Roblox Studio with `rojo serve` (one at a time, since the Studio plugin connects to one
 * port). Rojo only reads the project's files and serves them to Studio on this computer; it runs none of them.
 */
export class StudioSync {
  private child: ChildProcess | null = null
  private state: StudioSyncState = OFF
  /** The separate copy a review is served from, while one is. */
  private preview: { root: string; dir: string } | null = null

  constructor(private readonly deps: { rojo: () => string | null; emit: (s: StudioSyncState) => void; spawnFn?: typeof spawn; previewDir?: (projectId: string) => string }) {}

  status(): StudioSyncState {
    return this.state
  }

  private set(s: StudioSyncState): StudioSyncState {
    this.state = s
    this.deps.emit(s)
    return s
  }

  /** Serve the game as it is in its folder. */
  start(project: Project): StudioSyncState {
    this.stop()
    return this.serve(project, project.path, null)
  }

  /**
   * Serve a review's change from a separate copy of the game at that commit, so you can try it in Studio without your
   * folder switching branches. "Show the latest" (start) or a merge/discard goes back to the folder.
   */
  async startReview(project: Project, review: Review): Promise<StudioSyncState> {
    this.stop()
    if (!this.deps.previewDir) throw new Error('Trying reviews in Studio is not set up.')
    const dir = this.deps.previewDir(project.id)
    await removeTempWorktree(project.path, dir)
    rmSync(dir, { recursive: true, force: true })
    // Links or submodules in the change could pull in files from elsewhere on your computer.
    const links = await linksInCommit(project.path, review.headSha)
    if (links.length) return this.set({ projectId: project.id, status: 'error', port: SYNC_PORT, message: `This change has links or submodules, so Hangar won't show it in Studio: ${links.slice(0, 3).join(', ')}`, reviewId: review.id, reviewTitle: review.title })
    await addTempWorktree(project.path, review.headSha, dir)
    this.preview = { root: project.path, dir }
    return this.serve(project, dir, review)
  }

  private serve(project: Project, dir: string, review: Review | null): StudioSyncState {
    const showing = { reviewId: review?.id ?? null, reviewTitle: review?.title ?? null }
    const fail = (message: string): StudioSyncState => this.set({ projectId: project.id, status: 'error', port: SYNC_PORT, message, ...showing })
    const rojo = this.deps.rojo()
    if (!rojo) return fail("Rojo isn't installed. Use Install Rojo, or set its full path in Settings → Roblox.")
    const file = projectFile(dir)
    if (!file) return fail('No Rojo project file (default.project.json) in this game.')
    if (linkInPath(dir, join(dir, file))) return fail(`${file} is a link, so Hangar won't serve it.`)
    // A "$path" that leaves the project would put files from elsewhere on your computer into Studio.
    const bad = unsafeRojoPaths(dir)
    if (bad.length) return fail(`Rojo project files point outside the game, so Hangar won't serve them: ${bad.slice(0, 3).join('; ')}`)

    const child = (this.deps.spawnFn ?? spawn)(rojo, ['serve', file, '--address', '127.0.0.1', '--port', String(SYNC_PORT)], {
      cwd: dir,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.set({ projectId: project.id, status: 'starting', port: SYNC_PORT, message: null, ...showing })
    let tail = ''
    const read = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-2000)
      if (this.child === child && this.state.status === 'starting' && /listening|Port:\s*\d+/i.test(tail)) {
        this.set({ projectId: project.id, status: 'running', port: SYNC_PORT, message: null, ...showing })
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (e) => {
      if (this.child !== child) return
      this.child = null
      fail(`Couldn't start Rojo: ${e.message}`)
    })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      const last = tail.trim().split('\n').slice(-3).join(' ').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 400)
      fail(/address already in use|in use|10048/i.test(tail) ? `Port ${SYNC_PORT} is busy: another \`rojo serve\` is probably running. Stop it and try again.` : `Rojo stopped${last ? `: ${last}` : '.'}`)
    })
    return this.state
  }

  stop(): StudioSyncState {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
    const preview = this.preview
    this.preview = null
    if (preview) {
      void removeTempWorktree(preview.root, preview.dir).finally(() => rmSync(preview.dir, { recursive: true, force: true }))
    }
    return this.state.status === 'off' ? this.state : this.set(OFF)
  }

  /** Put the Rojo plugin into Studio's plugins folder (restart Studio after). */
  installPlugin(): Promise<void> {
    const rojo = this.deps.rojo()
    if (!rojo) return Promise.reject(new Error("Rojo isn't installed. Use Install Rojo first."))
    return run(rojo, ['plugin', 'install'], homedir())
  }
}

/** Install Rojo for every folder with Rokit (`rokit add --global rojo-rbx/rojo`). */
export function installRojo(home = homedir()): Promise<void> {
  const rokit = resolveCommand('rokit') ?? (existsSync(join(home, '.rokit', 'bin', 'rokit')) ? join(home, '.rokit', 'bin', 'rokit') : null)
  if (!rokit) return Promise.reject(new Error('Hangar installs Rojo with Rokit, which isn\'t installed. Get it from github.com/rojo-rbx/rokit, or install Rojo another way.'))
  return run(rokit, ['add', '--global', 'rojo-rbx/rojo'], home).catch((e: Error) => {
    // Already added globally is fine.
    if (/already/i.test(e.message)) return
    throw e
  })
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile(cmd, args, { cwd, env: minimalEnv(), timeout: 3 * 60 * 1000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 400)))
      else resolveRun()
    })
  })
}
