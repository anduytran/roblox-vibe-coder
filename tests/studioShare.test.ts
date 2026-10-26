import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AppSettings, Project, StudioSyncState } from '../src/shared/types'
import { AgentRunner, type CanUseTool, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { saveRole } from '../src/main/roles'
import { trustTaskCopy } from '../src/main/git'
import { mirrorGame, StudioSync } from '../src/main/studioSync'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

function repo(): { dir: string; g: (...a: string[]) => string } {
  const dir = tmp('hangar-share-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src' } } }))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'Gun.luau'), 'return 1\n')
  writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  return { dir, g }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  kill(): boolean {
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

test('studio view: holds exactly the game files (tracked and new, never ignored files or links), and follows changes', async () => {
  const { dir } = repo()
  const view = join(tmp('hangar-view-'), 'v')
  writeFileSync(join(dir, 'src', 'New.luau'), 'new\n')
  writeFileSync(join(dir, 'secret.env'), 'KEY=1')
  symlinkSync('/etc/hosts', join(dir, 'src', 'hosts.luau'))
  await mirrorGame(dir, view)
  assert.equal(readFileSync(join(view, 'src', 'Gun.luau'), 'utf8'), 'return 1\n')
  assert.equal(readFileSync(join(view, 'src', 'New.luau'), 'utf8'), 'new\n')
  assert.equal(existsSync(join(view, 'secret.env')), false, 'git-ignored files are never copied')
  assert.equal(existsSync(join(view, 'src', 'hosts.luau')), false, 'links are never followed')
  assert.equal(existsSync(join(view, '.git')), false)
  // A file removed from the game goes from the view too; a changed one is updated.
  execFileSync('rm', [join(dir, 'src', 'New.luau')])
  writeFileSync(join(dir, 'src', 'Gun.luau'), 'return 2\n')
  await mirrorGame(dir, view)
  assert.equal(existsSync(join(view, 'src', 'New.luau')), false)
  assert.equal(readFileSync(join(view, 'src', 'Gun.luau'), 'utf8'), 'return 2\n')
})

test('studio view: Rojo serves one folder; switching what Studio shows copies into it without restarting', async () => {
  const { dir, g } = repo()
  const other = tmp('hangar-share-other-')
  g('worktree', 'add', '-q', '-b', 'hangar/main-x-abc123', other)
  trustTaskCopy(other, dir) // as Hangar does for the copies it makes
  writeFileSync(join(other, 'src', 'Gun.luau'), 'return "task"\n')
  const views = tmp('hangar-views-')
  const states: StudioSyncState[] = []
  const spawned: string[] = []
  let child!: FakeChild
  const sync = new StudioSync({
    rojo: () => '/opt/rojo',
    emit: (s) => states.push(s),
    viewDir: (id) => join(views, id),
    spawnFn: ((_c: string, _a: string[], o: { cwd: string }) => {
      spawned.push(o.cwd)
      child = new FakeChild()
      return child
    }) as never
  })
  const project = { id: 'p1', name: 'G', path: dir, createdAt: 1, settings: {} } as Project
  test.after?.(() => sync.stop())
  sync.start(project)
  await until(() => spawned.length === 1)
  assert.equal(spawned[0], join(views, 'p1'), 'Rojo serves the view, not the game folder')
  child.stdout.emit('data', Buffer.from('Rojo server listening:\n  Port:    34872\n'))
  assert.equal(sync.showing('p1')?.kind, 'main')
  const st = await sync.show(project, other, { kind: 'task', label: 'Scripter: shop', agentId: 'scripter' })
  assert.equal(st.status, 'running', st.message ?? '')
  assert.equal(spawned.length, 1, 'no restart, so Studio stays connected')
  assert.equal(st.showing?.label, 'Scripter: shop')
  assert.equal(readFileSync(join(views, 'p1', 'src', 'Gun.luau'), 'utf8'), 'return "task"\n')
  await sync.show(project, dir, { kind: 'main', label: 'your game folder' })
  assert.equal(readFileSync(join(views, 'p1', 'src', 'Gun.luau'), 'utf8'), 'return 1\n')
  sync.stop()
})

test('studio lock: one task at a time gets Studio, switched to its own copy; the next waits, then gets it', async () => {
  const { dir, g } = repo()
  saveRole(dir, { id: 'scripter', name: 'Scripter', description: 'code', prompt: 'Write code.' })
  g('add', '.')
  g('commit', '-qm', 'roles')
  const registry = new ProjectRegistry(join(tmp('hangar-sl-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true, sandbox: false, autoApproveEdits: true } })
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 3, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const shown: { dir: string; label: string }[] = []
  let released = 0
  const order: string[] = []
  const gates = new Map<string, () => void>()
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: prompt, mcp_servers: [] }
      const can = options.canUseTool as CanUseTool
      const ac = new AbortController()
      const r = await can('mcp__Roblox_Studio__start_stop_play', { mode: 'start_play' }, { signal: ac.signal })
      order.push(`${prompt}:${r.behavior}`)
      await new Promise<void>((done) => gates.set(prompt, done))
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-sl-c-'), 'c.json')),
    getSettings: () => settings,
    getApiKey: () => 'k',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-sl-p-'), 'a.json'),
    trustFile: join(tmp('hangar-sl-t-'), 't.json'),
    appDataDir: tmp('hangar-sl-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-sl-rv-'), 'r.json')),
    studio: {
      show: async (_p, d, s) => {
        shown.push({ dir: d, label: s.label })
        return null
      },
      release: () => {
        released++
      }
    }
  })
  runner.send(project.id, 'main', 'playtest A')
  await until(() => order.length === 1)
  runner.send(project.id, 'scripter', 'playtest B')
  await tick(200)
  assert.deepEqual(order, ['playtest A:allow'], 'B waits for Studio')
  assert.equal(shown.length, 1)
  assert.match(shown[0]!.label, /^Main: playtest A/)
  assert.notEqual(shown[0]!.dir, dir, "Studio gets the task's own copy")
  gates.get('playtest A')!()
  await until(() => order.length === 2)
  assert.deepEqual(order, ['playtest A:allow', 'playtest B:allow'])
  assert.match(shown[1]!.label, /^Scripter: playtest B/)
  assert.notEqual(shown[1]!.dir, shown[0]!.dir)
  gates.get('playtest B')!()
  await until(() => released === 2)
})
