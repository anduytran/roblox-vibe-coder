import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings, Review } from '../src/shared/types'
import { AgentRunner, type QueryFn } from '../src/main/agentRunner'
import { autoMergeBlocker } from '../src/main/autopilot'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewActions } from '../src/main/reviewActions'
import { ReviewStore } from '../src/main/reviews'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 8000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** An autonomous git project whose fake agent writes Gun.luau, and resolves clashes the way `resolve` says. */
function setup(resolve: (text: string) => string, hold: Promise<void> = Promise.resolve()) {
  const dir = tmp('hangar-cf-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'Gun.luau'), 'return {}\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const registry = new ProjectRegistry(join(tmp('hangar-cf-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true, reviewer: false, sandbox: false } })
  const reviews = new ReviewStore(join(tmp('hangar-cf-rv-'), 'reviews.json'))
  const prompts: string[] = []
  const resumed: unknown[] = []
  const query: QueryFn = ({ prompt, options }) => {
    prompts.push(prompt)
    resumed.push(options.resume)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `s${prompts.length}`, mcp_servers: [] }
      const file = join(options.cwd as string, 'Gun.luau')
      if (prompt.includes('slow')) await hold
      if (prompt.includes('Hangar has merged the latest')) writeFileSync(file, resolve(readFileSync(file, 'utf8')))
      else writeFileSync(file, `return { gun = "${prompt}" }\n`)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `Did: ${prompt.slice(0, 40)}` }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  }
  const events: AgentEvent[] = []
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-cf-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-cf-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-cf-t-'), 'trust.json'),
    appDataDir: tmp('hangar-cf-app-'),
    platform: 'linux',
    reviews
  })
  const actions = new ReviewActions({ registry, reviews, runner, emit: (e) => events.push(e), publisher: null })
  const idle = () => runner.snapshot(project.id).every((a) => a.status !== 'working' && a.status !== 'queued')
  return { dir, g, project, registry, runner, reviews, actions, prompts, resumed, idle }
}

/** Two changes made from the same starting point; the first is merged, so the second clashes. */
async function clashing(t: ReturnType<typeof setup>): Promise<Review> {
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'gun B')
  await until(() => t.reviews.list().length === 2 && t.idle())
  const [a, b] = [t.reviews.list().find((r) => r.title === 'gun A')!, t.reviews.list().find((r) => r.title === 'gun B')!]
  await t.actions.merge(a.id)
  await assert.rejects(t.actions.merge(b.id), /clashes with work already on main \(in Gun\.luau\)/)
  const clashed = t.reviews.get(b.id)
  assert.deepEqual(clashed.clash?.files, ['Gun.luau'])
  assert.match(autoMergeBlocker(clashed) ?? '', /clashes with newer work on main/)
  return clashed
}

test('fix with AI: the agent resolves the clash, the review moves onto main, and it merges', async () => {
  const t = setup((text) => {
    assert.match(text, /^<<<<<<< /m, 'the agent sees the conflict')
    return 'return { gun = "A", alt = "B" }\n'
  })
  const b = await clashing(t)
  const mainTip = t.g('rev-parse', 'main')
  const fixing = t.actions.fixClash(b.id)
  assert.equal(fixing.clash?.fixing, true)
  assert.throws(() => t.actions.fixClash(b.id), /already resolving/)
  await until(() => !t.reviews.get(b.id).clash && t.idle())
  const fixed = t.reviews.get(b.id)
  assert.equal(fixed.baseSha, mainTip, 'now shows only the change on top of main')
  assert.equal(fixed.clashFixes, 1)
  assert.match(t.prompts.at(-1)!, /These files have conflicts:\n- Gun\.luau/)
  assert.equal(t.resumed.at(-1), undefined, 'a clash fix is its own short conversation')
  assert.equal(t.g('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(t.g('status', '--porcelain'), '')
  const diff = await t.actions.diff(b.id)
  assert.match(diff, /\+return \{ gun = "A", alt = "B" \}/)
  assert.doesNotMatch(diff, /gun B" \}\n\+/, 'main\'s own work is not shown as part of the change')
  await t.actions.merge(b.id)
  assert.equal(readFileSync(join(t.dir, 'Gun.luau'), 'utf8'), 'return { gun = "A", alt = "B" }\n')
  assert.equal(t.g('log', '--format=%s', '-1'), 'gun B')
})

test('fix with AI: markers left behind are refused and the change goes back exactly as it was', async () => {
  const t = setup((text) => text) // leaves the conflict in
  const b = await clashing(t)
  t.actions.fixClash(b.id)
  await until(() => t.reviews.get(b.id).clash?.fixing === false && t.idle())
  const after = t.reviews.get(b.id)
  assert.match(after.clash?.failed ?? '', /Conflict markers are still in Gun\.luau/)
  assert.equal(after.headSha, b.headSha)
  assert.equal(after.baseSha, b.baseSha)
  assert.equal(after.clashFixes, 1)
  assert.equal(t.g('rev-parse', `refs/heads/${b.branch}`), b.headSha, 'branch put back')
  assert.equal(t.g('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(t.g('status', '--porcelain'), '', 'nothing half-merged left in the folder')
  assert.doesNotMatch(readFileSync(join(t.dir, 'Gun.luau'), 'utf8'), /<<<<<<</)
})

test('autopilot: while you are away a clash is handed to the agent, at most twice, then waits for the morning', async () => {
  const { Autopilot, MAX_CLASH_FIXES } = await import('../src/main/autopilot')
  const registry = new ProjectRegistry(join(tmp('hangar-cfa-'), 'p.json'))
  const project = registry.add(tmp('hangar-cfa-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-cfa-r-'), 'r.json'))
  const sent: string[] = []
  const fixes: string[] = []
  const passed = { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed' as const, output: '', ms: 1 }] }
  const ap = new Autopilot({
    file: join(tmp('hangar-cfa-a-'), 'a.json'),
    registry,
    reviews,
    costs: new CostTracker(join(tmp('hangar-cfa-c-'), 'c.json')),
    emit: () => {},
    send: (_p, _a, prompt) => {
      sent.push(prompt)
    },
    merge: async (id) => {
      reviews.update(id, { clash: { files: ['Gun.luau'], at: 1, fixing: false, failed: null } })
      throw new Error('clashes')
    },
    fixClash: (id) => {
      fixes.push(id)
      const r = reviews.get(id)
      reviews.update(id, { clash: { ...r.clash!, fixing: true } })
    }
  })
  ap.start(project.id, { config: { sprintTasks: 1 } as never })
  ap.configure(project.id, { unattended: true, unattendedUntil: Date.now() + 3600_000, unattendedBudgetUsd: 20 })
  const r = reviews.add({ projectId: project.id, agentId: 'lead', title: 'Gun', branch: 'hangar/lead-gun-abc123', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'Gun', files: ['Gun.luau'], incomplete: null, note: null, clip: null })
  reviews.update(r.id, { checks: passed })
  ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: 't1', prompt: sent[0]!, createdAt: 1, origin: 'autopilot' }, ok: true, stopped: false, text: 'Built it.', error: null, reviewId: r.id })
  await until(() => fixes.length === 1)
  assert.equal(ap.get(project.id).awaitingReviewId, r.id, 'waits for the fix')
  // The fix failed; it gets one more try, then the change waits for you and work goes on.
  for (let i = 1; i <= MAX_CLASH_FIXES; i++) {
    reviews.update(r.id, { clash: { files: ['Gun.luau'], at: 1, fixing: false, failed: 'markers left' }, clashFixes: i })
    ap.onReview(reviews.get(r.id))
  }
  assert.equal(fixes.length, MAX_CLASH_FIXES)
  assert.equal(ap.get(project.id).awaitingReviewId, null)
  assert.equal(ap.get(project.id).away!.leftForYou, 1)
})

test('merge all: merges in order; a clash is fixed by AI and merges itself once checked again', async () => {
  const t = setup(() => 'return { gun = "A", alt = "B" }\n')
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'gun B')
  await until(() => t.reviews.list().length === 2 && t.idle())
  const passed = { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed' as const, output: '', ms: 1 }] }
  for (const r of t.reviews.list()) t.reviews.update(r.id, { checks: passed })
  const res = await t.actions.mergeAll(t.project.id, {})
  assert.equal(res.merged.length, 1)
  assert.equal(res.fixing.length, 1)
  assert.deepEqual(res.skipped, [])
  const b = res.fixing[0]!
  await until(() => !t.reviews.get(b).clash && t.idle())
  // The pipeline checks the fixed change again; once that's done, it merges itself.
  t.actions.onReview(t.reviews.update(b, { checks: passed }))
  await until(() => t.reviews.get(b).status === 'merged')
  assert.equal(readFileSync(join(t.dir, 'Gun.luau'), 'utf8'), 'return { gun = "A", alt = "B" }\n')
  assert.equal(t.g('status', '--porcelain'), '')
})

test('merge all: a fixed change whose checks fail is left for you', async () => {
  const t = setup(() => 'return { broken = true }\n')
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'gun B')
  await until(() => t.reviews.list().length === 2 && t.idle())
  const res = await t.actions.mergeAll(t.project.id, {})
  const b = res.fixing[0]!
  await until(() => !t.reviews.get(b).clash && t.idle())
  const failed = { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'failed' as const, output: 'bad', ms: 1 }] }
  t.actions.onReview(t.reviews.update(b, { checks: failed }))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(t.reviews.get(b).status, 'pending')
})

test('push after merge: nothing is sent without a linked repository or with the switch off', async () => {
  const t = setup((x) => x)
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  const a = t.reviews.list()[0]!
  await t.actions.merge(a.id)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(t.reviews.get(a.id).pushed, undefined, 'not linked: nothing pushed')
  assert.equal(t.reviews.get(a.id).pushError, undefined, 'and no error either')

  // Linked, switch off: still nothing (no network call is made).
  t.g('remote', 'add', 'origin', 'https://github.com/example/not-a-real-repo-xyz.git')
  t.registry.update(t.project.id, { settings: { autoPush: false } })
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'gun B')
  await until(() => t.reviews.list().length === 2 && t.idle())
  const b = t.reviews.list().find((r) => r.id !== a.id)!
  await t.actions.merge(b.id)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(t.reviews.get(b.id).status, 'merged')
  assert.equal(t.reviews.get(b.id).pushed, undefined)
  assert.equal(t.reviews.get(b.id).pushError, undefined)
  assert.equal(t.registry.get(t.project.id).settings.autoPush, false)
})

test('merge all: while an agent is working, changes are queued and merge as soon as its task ends', async () => {
  let release: () => void = () => {}
  const hold = new Promise<void>((r) => (release = r))
  const t = setup((x) => x, hold)
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  const a = t.reviews.list()[0]!
  t.reviews.update(a.id, { checks: { status: 'done', reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed', output: '', ms: 1 }] } })
  // The agent starts another (slow) task: the folder is busy.
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'slow work')
  await until(() => t.runner.projectBusy(t.project.id))
  const res = await t.actions.mergeAll(t.project.id, {})
  assert.deepEqual(res.merged, [])
  assert.deepEqual(res.queued, [a.id])
  assert.equal(t.reviews.get(a.id).mergeQueued, true)
  assert.equal(t.reviews.get(a.id).status, 'pending')
  // The task ends: the queued change merges before anything else starts.
  release()
  await until(() => t.reviews.get(a.id).status === 'merged')
  assert.equal(t.reviews.get(a.id).mergeQueued, false)
  assert.deepEqual(t.actions.queued(t.project.id), [])
})

test('merge all: stopping it leaves the changes in Reviews', async () => {
  let release: () => void = () => {}
  const hold = new Promise<void>((r) => (release = r))
  const t = setup((x) => x, hold)
  t.runner.send(t.project.id, 'main', 'gun A')
  await until(() => t.reviews.list().length === 1 && t.idle())
  const a = t.reviews.list()[0]!
  t.runner.resetSession(t.project.id, 'main')
  t.runner.send(t.project.id, 'main', 'slow work')
  await until(() => t.runner.projectBusy(t.project.id))
  await t.actions.mergeAll(t.project.id, {})
  t.actions.cancelMergeAll(t.project.id)
  assert.equal(t.reviews.get(a.id).mergeQueued, false)
  release()
  await until(() => t.idle())
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(t.reviews.get(a.id).status, 'pending')
})
