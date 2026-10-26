import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project, StudioSyncState } from '@shared/types'
import { minimalEnv } from './env'
import { linkInPath } from './pathScope'
import { resolveCommand, unsafeRojoPaths } from './testPlace'

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
  const resolved = resolveCommand(command)
  if (resolved && !shimDirs(home).includes(dirname(resolved))) return resolved
  const exe = platform === 'win32' ? 'rojo.exe' : 'rojo'
  for (const tool of ['.rokit', '.aftman']) {
    const store = join(home, tool, 'tool-storage', 'rojo-rbx', 'rojo')
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

  constructor(private readonly deps: { rojo: () => string | null; emit: (s: StudioSyncState) => void; spawnFn?: typeof spawn }) {}

  status(): StudioSyncState {
    return this.state
  }

  private set(s: StudioSyncState): StudioSyncState {
    this.state = s
    this.deps.emit(s)
    return s
  }

  start(project: Project): StudioSyncState {
    this.stop()
    const fail = (message: string): StudioSyncState => this.set({ projectId: project.id, status: 'error', port: SYNC_PORT, message })
    const rojo = this.deps.rojo()
    if (!rojo) return fail("Rojo isn't installed. Use Install Rojo, or set its full path in Settings → Roblox.")
    const file = projectFile(project.path)
    if (!file) return fail('No Rojo project file (default.project.json) in this game.')
    if (linkInPath(project.path, join(project.path, file))) return fail(`${file} is a link, so Hangar won't serve it.`)
    // A "$path" that leaves the project would put files from elsewhere on your computer into Studio.
    const bad = unsafeRojoPaths(project.path)
    if (bad.length) return fail(`Rojo project files point outside the game, so Hangar won't serve them: ${bad.slice(0, 3).join('; ')}`)

    const child = (this.deps.spawnFn ?? spawn)(rojo, ['serve', file, '--address', '127.0.0.1', '--port', String(SYNC_PORT)], {
      cwd: project.path,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.set({ projectId: project.id, status: 'starting', port: SYNC_PORT, message: null })
    let tail = ''
    const read = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-2000)
      if (this.child === child && this.state.status === 'starting' && /listening|Port:\s*\d+/i.test(tail)) {
        this.set({ projectId: project.id, status: 'running', port: SYNC_PORT, message: null })
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
