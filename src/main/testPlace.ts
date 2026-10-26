import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { delimiter, isAbsolute, join, sep } from 'node:path'
import type { Review } from '@shared/types'
import { addTempWorktree, linksInCommit, removeTempWorktree } from './git'
import type { ProjectRegistry } from './projects'
import type { Publisher } from './reviewActions'

/** Where publishing gets a project's Open Cloud key (see testPlaceKeys.ts). */
export interface KeySource {
  get(projectId: string): string | null
}

/**
 * "Publish to test place": builds a review's branch with Rojo and uploads it to the project's private
 * test place through Roblox's Open Cloud place-publishing API, so you can play it on your phone.
 *
 * Guardrails: only ever on your tap (agents have no way to call this); only to the universe/place
 * IDs you saved for that project; the Open Cloud key is stored encrypted per project, never shown to
 * agents, and should be created with only the universe-places Write permission for that one game.
 * The branch is built in a temporary separate folder, so your project folder is untouched.
 */
const MAX_PLACE_BYTES = 100 * 1024 * 1024

export function validateOpenCloudKey(key: string): string | null {
  return /^[A-Za-z0-9+/=._-]{20,2000}$/.test(key) ? null : 'That does not look like a Roblox Open Cloud API key.'
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile(cmd, args, { cwd, timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 500)))
      else resolveRun()
    })
  })
}

export function uploadPlace(opts: { universeId: string; placeId: string; apiKey: string; body: Buffer; host?: string; versionType?: 'Published' | 'Saved' }): Promise<{ versionNumber: number }> {
  return new Promise((resolveUpload, reject) => {
    const req = request(
      {
        host: opts.host ?? 'apis.roblox.com',
        method: 'POST',
        path: `/universes/v1/${encodeURIComponent(opts.universeId)}/places/${encodeURIComponent(opts.placeId)}/versions?versionType=${opts.versionType ?? 'Published'}`,
        headers: { 'x-api-key': opts.apiKey, 'content-type': 'application/octet-stream', 'content-length': opts.body.length },
        timeout: 5 * 60 * 1000
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (data.length < 100_000) data += c
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const v = (JSON.parse(data) as { versionNumber?: unknown }).versionNumber
              if (typeof v === 'number') return resolveUpload({ versionNumber: v })
            } catch {
              // fall through
            }
            return reject(new Error('Roblox accepted the upload but returned an unexpected response.'))
          }
          const hint =
            res.statusCode === 401 || res.statusCode === 403
              ? ' Check the API key has the universe-places Write permission for this game.'
              : res.statusCode === 404
                ? ' Check the universe and place IDs.'
                : ''
          reject(new Error(`Roblox rejected the upload (HTTP ${res.statusCode}).${hint} ${data.slice(0, 300)}`.trim()))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Upload timed out')))
    req.on('error', reject)
    req.end(opts.body)
  })
}

/**
 * Every "$path" in Rojo project files must be a plain relative path inside the project: an absolute
 * path, "..", "~" or a drive letter could pull files from elsewhere on your computer into the place.
 */
export function unsafeRojoPaths(treeDir: string): string[] {
  const bad: string[] = []
  const visit = (node: unknown, file: string): void => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$path') {
        const p = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { optional?: unknown }).optional === 'string' ? (v as { optional: string }).optional : null
        if (p === null) bad.push(`${file}: unrecognised $path`)
        else if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('~') || p.split(/[\\/]/).includes('..') || /^[\\/]{2}/.test(p)) bad.push(`${file}: ${p}`)
      } else visit(v, file)
    }
  }
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue
      const full = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) walk(full, r)
      else if (name.endsWith('.project.json')) {
        try {
          visit(JSON.parse(readFileSync(full, 'utf8')), r)
        } catch {
          bad.push(`${r}: not valid JSON`)
        }
      }
    }
  }
  walk(treeDir, '')
  return bad
}

/** Resolve a command to an absolute path from PATH, never from the current folder. */
export function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : null
  if (cmd.includes('/') || cmd.includes('\\')) return null
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const full = join(dir, cmd + ext.toLowerCase())
      const fullUpper = join(dir, cmd + ext)
      if (existsSync(full)) return full
      if (existsSync(fullUpper)) return fullUpper
    }
  }
  return null
}

export class TestPlacePublisher implements Publisher {
  constructor(
    private readonly deps: {
      registry: ProjectRegistry
      keys: KeySource
      rojoCommand: () => string
      /** A folder Hangar owns (inside its data folder), for build checkouts. */
      workDir: string
    }
  ) {}

  async publish(review: Review): Promise<{ versionNumber: number }> {
    const project = this.deps.registry.get(review.projectId)
    const place = project.settings.testPlace
    if (!place) throw new Error('Set this project\'s test place (universe and place IDs) in the Project tab first.')
    const apiKey = this.deps.keys.get(project.id)
    if (!apiKey) throw new Error('Add a Roblox Open Cloud API key for this project in the Project tab first.')
    const rojo = resolveCommand(this.deps.rojoCommand())
    if (!rojo) throw new Error(`Couldn't find Rojo ("${this.deps.rojoCommand()}"). Install it or set its full path in Settings → Roblox.`)

    // Symlinks and submodules could pull in files from outside the project; refuse them.
    const links = await linksInCommit(project.path, review.headSha)
    if (links.length) throw new Error(`This branch contains symlinks or submodules, which can't be published: ${links.slice(0, 5).join(', ')}`)

    mkdirSync(this.deps.workDir, { recursive: true })
    const work = mkdtempSync(join(this.deps.workDir, 'publish-'))
    const tree = join(work, 'tree')
    const out = join(work, 'place.rbxl')
    try {
      await addTempWorktree(project.path, review.headSha, tree)
      const bad = unsafeRojoPaths(tree)
      if (bad.length) throw new Error(`Rojo project files point outside the project, so this branch can't be published: ${bad.slice(0, 5).join('; ')}`)
      // Run Rojo from Hangar's own folder (not the branch checkout), using the resolved binary.
      await run(rojo, ['build', tree + sep, '-o', out], work).catch((e: Error) => {
        throw new Error(`Rojo couldn't build this branch: ${e.message}`)
      })
      const size = statSync(out).size
      if (size > MAX_PLACE_BYTES) throw new Error('The built place is too large to upload.')
      return await uploadPlace({ universeId: place.universeId, placeId: place.placeId, apiKey, body: readFileSync(out) })
    } finally {
      await removeTempWorktree(project.path, tree)
      rmSync(work, { recursive: true, force: true })
    }
  }
}
