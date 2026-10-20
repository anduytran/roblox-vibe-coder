import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { resolveCommand } from './testPlace'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Review } from '@shared/types'
import type { ClipRecorder, ClipSession } from './agentRunner'

/**
 * Playtest clips for reviews.
 *
 * Hangar (never the agent) records only the Roblox Studio window while the agent's playtest runs:
 *  - macOS: `screencapture -v` limited to Studio's window rectangle (needs Screen Recording and
 *    Accessibility permission for Hangar, granted once). Converted to .mp4 if ffmpeg is installed.
 *  - Windows: ffmpeg's gdigrab capture of the Studio window by its title (needs ffmpeg installed).
 * Recording starts when the agent starts a playtest and stops when it stops one, capped at 30 s.
 * If recording isn't possible, the screenshots the agent takes during the playtest become a
 * slideshow instead. Clips are stored in Hangar's data folder, never in the project.
 */
const MAX_SECONDS = 30
const MAX_FRAMES = 40
const MAX_FRAME_BYTES = 5 * 1024 * 1024

/** The real image type from the file's first bytes (never trust the declared type). */
function sniffImage(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}
const PLAY_TOOL = /__start_stop_play$/

type Platform = NodeJS.Platform

/**
 * Helper programs by absolute path only. On Windows a bare name is looked up in the current folder
 * before PATH, so a project folder containing "ffmpeg.exe" could otherwise be run.
 */
export function helperPath(name: 'ffmpeg' | 'powershell' | 'osascript' | 'screencapture', platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name === 'osascript') return platform === 'darwin' ? '/usr/bin/osascript' : null
  if (name === 'screencapture') return platform === 'darwin' ? '/usr/sbin/screencapture' : null
  if (name === 'powershell') {
    if (platform !== 'win32') return null
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }
  return resolveCommand('ffmpeg', env, platform)
}

function exec(cmd: string | null, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolveExec, reject) => {
    if (!cmd) return reject(new Error('Helper program not available.'))
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, out) => (err ? reject(err) : resolveExec(String(out))))
  })
}

async function hasCommand(cmd: string | null): Promise<boolean> {
  try {
    await exec(cmd, ['-version'], 5000)
    return true
  } catch {
    return false
  }
}

/** Studio window rectangle on macOS (points), via System Events. */
async function macStudioRect(): Promise<string | null> {
  const script =
    'tell application "System Events" to tell (first process whose name starts with "RobloxStudio") to get {position, size} of front window'
  try {
    const out = (await exec(helperPath('osascript'), ['-e', script])).trim()
    const n = out.split(/\s*,\s*/).map((x) => Math.round(Number(x)))
    if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2]! < 50 || n[3]! < 50) return null
    return n.join(',')
  } catch {
    return null
  }
}

/** Studio's window title on Windows, for ffmpeg's gdigrab. */
async function windowsStudioTitle(): Promise<string | null> {
  try {
    const out = await exec(helperPath('powershell'), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle"
    ])
    const title = out.trim()
    return title && title.length < 300 ? title : null
  } catch {
    return null
  }
}

class Session implements ClipSession {
  private recorder: ChildProcess | null = null
  private recordingFile: string | null = null
  private recordedOnce = false
  private frames: string[] = []
  private starting: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string,
    private readonly platform: Platform,
    private readonly ffmpeg: Promise<boolean>
  ) {
    mkdirSync(dir, { recursive: true })
  }

  onToolUse(name: string): void {
    if (!PLAY_TOOL.test(name)) return
    if (this.recorder || this.starting) this.stopRecording()
    else if (!this.recordedOnce) this.starting = this.startRecording().finally(() => (this.starting = null))
  }

  onImages(images: { mediaType: string; data: string }[]): void {
    for (const img of images) {
      if (this.frames.length >= MAX_FRAMES) return
      if (img.data.length > (MAX_FRAME_BYTES * 4) / 3 + 4) continue
      const buf = Buffer.from(img.data, 'base64')
      const ext = sniffImage(buf)
      if (!ext || buf.length > MAX_FRAME_BYTES) continue
      const file = join(this.dir, `frame-${String(this.frames.length).padStart(3, '0')}.${ext}`)
      try {
        writeFileSync(file, buf)
        this.frames.push(file)
      } catch {
        // ignore unwritable frames
      }
    }
  }

  private async startRecording(): Promise<void> {
    this.recordedOnce = true
    if (this.platform === 'darwin') {
      const rect = await macStudioRect()
      if (!rect) return
      this.recordingFile = join(this.dir, 'playtest.mov')
      this.recorder = spawn(helperPath('screencapture') ?? '/usr/sbin/screencapture', ['-v', `-V${MAX_SECONDS}`, `-R${rect}`, '-x', this.recordingFile], { stdio: 'ignore' })
    } else if (this.platform === 'win32') {
      const [title, ok] = await Promise.all([windowsStudioTitle(), this.ffmpeg])
      const ffmpegPath = helperPath('ffmpeg', this.platform)
      if (!title || !ok || !ffmpegPath) return
      this.recordingFile = join(this.dir, 'playtest.mp4')
      this.recorder = spawn(
        ffmpegPath,
        ['-y', '-f', 'gdigrab', '-framerate', '15', '-i', `title=${title}`, '-t', String(MAX_SECONDS), '-vf', 'scale=-2:720',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', this.recordingFile],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
      )
    } else {
      return
    }
    this.recorder.on('error', () => (this.recorder = null))
    this.recorder.on('exit', () => (this.recorder = null))
    this.timer = setTimeout(() => this.stopRecording(), (MAX_SECONDS + 5) * 1000)
  }

  private stopRecording(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const r = this.recorder
    if (!r) return
    // ffmpeg finishes the file cleanly on "q"; screencapture on SIGINT.
    if (this.platform === 'win32') r.stdin?.write('q')
    else r.kill('SIGINT')
  }

  private async waitForRecorder(): Promise<void> {
    if (this.starting) await this.starting
    const r = this.recorder
    if (!r) return
    this.stopRecording()
    await new Promise<void>((done) => {
      const t = setTimeout(() => {
        r.kill('SIGKILL')
        done()
      }, 10_000)
      r.once('exit', () => {
        clearTimeout(t)
        done()
      })
    })
  }

  async finish(): Promise<Review['clip']> {
    await this.waitForRecorder()
    let video = this.recordingFile && existsSync(this.recordingFile) && statSync(this.recordingFile).size > 10_000 ? this.recordingFile : null
    if (video && video.endsWith('.mov') && (await this.ffmpeg)) {
      const mp4 = join(this.dir, 'playtest.mp4')
      try {
        await exec(helperPath('ffmpeg'), ['-y', '-i', video, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', mp4], 120_000)
        rmSync(video, { force: true })
        video = mp4
      } catch {
        // keep the .mov
      }
    }
    if (video) return { kind: 'video', files: [video] }
    if (this.frames.length) return { kind: 'frames', files: this.frames }
    rmSync(this.dir, { recursive: true, force: true })
    return null
  }

  abort(): void {
    if (this.timer) clearTimeout(this.timer)
    this.recorder?.kill('SIGKILL')
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export class StudioClipRecorder implements ClipRecorder {
  private ffmpeg: Promise<boolean> | null = null

  constructor(
    private readonly clipsDir: string,
    private readonly platform: Platform = process.platform
  ) {}

  begin(opts: { taskId: string }): ClipSession {
    this.ffmpeg ??= hasCommand(helperPath('ffmpeg', this.platform))
    const safe = opts.taskId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
    return new Session(join(this.clipsDir, safe), this.platform, this.ffmpeg)
  }

  /** Delete a review's clip files once it's merged or discarded. */
  static remove(files: string[]): void {
    for (const f of files) rmSync(f, { force: true })
  }
}
