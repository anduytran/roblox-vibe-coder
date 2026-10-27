import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AppSettings } from '../src/shared/types'
import { AgentRunner, CONTINUE_PROMPT, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 2, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'max', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 8000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** An autonomous git project whose fake agent edits Gun.luau, and stops when `outOfUsage` says so. */
function setup(opts: { persistFile?: string; dir?: string; costs?: CostTracker } = {}) {
  let dir = opts.dir
  if (!dir) {
    dir = tmp('hangar-up-')
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'me@example.com')
    g('config', 'user.name', 'Me')
    writeFileSync(join(dir, 'Gun.luau'), 'return {}\n')
    g('add', '.')
    g('commit', '-qm', 'init')
  }
  const registry = new ProjectRegistry(join(tmp('hangar-up-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true, reviewer: false, sandbox: false } })
  const reviews = new ReviewStore(join(tmp('hangar-up-rv-'), 'reviews.json'))
  const costs = opts.costs ?? new CostTracker(join(tmp('hangar-up-c-'), 'costs.json'))
  const calls: { prompt: string; resume: unknown }[] = []
  const state = { outOfUsage: true }
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, resume: options.resume })
    const n = calls.length
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: options.resume ? String(options.resume) : `s${n}`, mcp_servers: [] }
      writeFileSync(join(options.cwd as string, 'Gun.luau'), `return { step = ${n} }\n`)
      if (state.outOfUsage) {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ["You've hit your usage limit. Resets at 6pm."], total_cost_usd: 0.5 }
      } else {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Gun done.' }] } }
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.8 }
      }
    })()
  }
  const outcomes: { paused?: boolean; ok: boolean; reviewId: string | null; task: { prompt: string } }[] = []
  const persistFile = opts.persistFile ?? join(tmp('hangar-up-p-'), 'agents.json')
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs,
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-oat01-test',
    engineAuth: async (k) => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile,
    trustFile: join(tmp('hangar-up-t-'), 'trust.json'),
    appDataDir: tmp('hangar-up-app-'),
    platform: 'linux',
    reviews,
    onTaskDone: (o) => void outcomes.push(o)
  })
  const main = () => runner.snapshot(project.id).find((a) => a.agentId === 'main')!
  return { dir, project, registry, reviews, runner, calls, state, outcomes, main, persistFile, costs }
}

test('usage pause: a run stopped by the plan is held with its work, then continues in the same conversation and change', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'Autopilot item x1, sprint 1: build the gun', { origin: 'autopilot' })
  await until(() => t.outcomes.length === 1)
  const o = t.outcomes[0]!
  assert.equal(o.paused, true, 'not a failure')
  assert.ok(o.reviewId, 'its work so far is kept in a change')
  const review = t.reviews.get(o.reviewId!)
  assert.match(review.incomplete ?? '', /usage limit/)
  const m = t.main()
  assert.ok(m.paused && m.paused.until > Date.now() + 25 * 60_000, 'waits for the reset (about half an hour when the time is unknown)')
  assert.equal(m.status, 'queued')
  assert.equal(m.queue.length, 1)
  assert.equal(m.queue[0]!.prompt, 'Autopilot item x1, sprint 1: build the gun', 'the same task, so autopilot still knows it')
  assert.deepEqual(m.queue[0]!.continueFrom, { sessionId: 's1', reviewId: o.reviewId, costSoFar: 0.5 })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(t.calls.length, 1, "nothing runs while it's held")

  // Continue now (the plan has reset): the same conversation, adding to the same change.
  t.state.outOfUsage = false
  t.runner.continueNow(t.project.id, 'main')
  await until(() => t.outcomes.length === 2)
  assert.equal(t.calls[1]!.resume, 's1')
  assert.equal(t.calls[1]!.prompt, CONTINUE_PROMPT)
  const done = t.outcomes[1]!
  assert.equal(done.paused, false)
  assert.equal(done.ok, true)
  assert.equal(done.reviewId, o.reviewId, 'the same change')
  assert.equal(t.reviews.get(o.reviewId!).incomplete, null, 'no longer stopped early')
  assert.equal(t.main().paused ?? null, null)
})

test('usage pause: a task that would start while the plan is used up waits instead of failing, and survives a restart', async () => {
  const costs = new CostTracker(join(tmp('hangar-up-c2-'), 'costs.json'))
  const resetsAt = Math.floor((Date.now() + 2 * 3600_000) / 1000)
  costs.recordPlan({ rateLimitType: 'five_hour', status: 'rejected', resetsAt } as never)
  const t = setup({ costs })
  t.runner.send(t.project.id, 'main', 'add a shop')
  await until(() => t.outcomes.length === 1)
  assert.equal(t.outcomes[0]!.paused, true)
  assert.equal(t.calls.length, 0, 'the engine was never started')
  const until1 = t.main().paused!.until
  assert.ok(Math.abs(until1 - (resetsAt * 1000 + 60_000)) < 2000, 'a minute after the plan resets')
  // Hangar restarts: the held task is still there, still held.
  const again = setup({ persistFile: t.persistFile, dir: t.dir, costs })
  const back = again.runner.snapshot(again.project.id).find((a) => a.agentId === 'main')
  // The registry is new, so the project has a new id: look the agent up by the old one.
  void back
  const held = (again.runner as unknown as { states: Map<string, { paused: unknown; queue: { prompt: string }[] }> }).states.get(`${t.project.id}:main`)
  assert.ok(held?.paused, 'still held after a restart')
  assert.equal(held!.queue[0]!.prompt, 'add a shop')
})

test('usage pause: autopilot keeps waiting on a held task instead of counting it as failed', async () => {
  const { Autopilot } = await import('../src/main/autopilot')
  const registry = new ProjectRegistry(join(tmp('hangar-up-ap-'), 'p.json'))
  const project = registry.add(tmp('hangar-up-ap-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: string[] = []
  const ap = new Autopilot({ file: join(tmp('hangar-up-ap-a-'), 'a.json'), registry, reviews: new ReviewStore(join(tmp('hangar-up-ap-r-'), 'r.json')), costs: new CostTracker(join(tmp('hangar-up-ap-c-'), 'c.json')), emit: () => {}, send: (_p, _a, prompt) => void sent.push(prompt), merge: async () => undefined })
  ap.start(project.id, { config: { sprintTasks: 2, fastStart: false } as never })
  const before = ap.get(project.id)
  ap.onTaskDone({ projectId: project.id, agentId: 'main', task: { id: 't1', prompt: sent.at(-1)!, createdAt: 1, origin: 'autopilot' }, ok: false, stopped: false, text: '', error: "You've hit your usage limit", reviewId: null, paused: true })
  const after = ap.get(project.id)
  assert.equal(after.status, 'running')
  assert.equal(after.consecutiveFailures, before.consecutiveFailures)
  assert.equal(after.tasksDone, before.tasksDone)
  assert.equal(sent.length, 1, 'no next step yet')
})
