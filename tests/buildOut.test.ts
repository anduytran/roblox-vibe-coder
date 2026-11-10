import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Autopilot, BUILD_OUT, BUILD_OUT_FALLBACK, BUILD_OUT_MODEL, LAUNCH_PLAN, SIMPLE_MODEL, sprintMax } from '../src/main/autopilot'
import { CostTracker, fableHeadroom } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates } from '../src/main/roles'
import { CHECKLIST, SHIP_CHECKLIST } from '../src/main/ship'
import { sanitizeNewGame } from '../src/main/scaffold'

// "Build out the full game": a new game's first plan goes all the way to launch, not an MVP, and the build runs on
// Fable while the plan's usage allows it, otherwise on Opus 5.5.

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const plan = (items: unknown[]): string => `Plan.\n\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``

function setup(fable: { ok: boolean }) {
  const dir = tmp('hangar-bo-')
  installTemplates(dir)
  mkdirSync(join(dir, 'design-vault'), { recursive: true })
  const registry = new ProjectRegistry(join(tmp('hangar-bo-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: { agent: string; prompt: string; model?: string }[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-bo-a-'), 'a.json'),
    registry,
    reviews: new ReviewStore(join(tmp('hangar-bo-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-bo-c-'), 'c.json')),
    emit: () => {},
    send: (_p, agent, prompt, opts) => void sent.push({ agent, prompt, model: opts.model }),
    merge: async () => {},
    fableOk: () => fable.ok
  })
  const done = (prompt: string, agent: string, extra: { text?: string; origin?: 'autopilot' | 'autopilot-report' } = {}) =>
    ap.onTaskDone({ projectId: project.id, agentId: agent, task: { id: `t${sent.length}`, prompt, createdAt: 1, origin: extra.origin ?? 'autopilot' }, ok: true, stopped: false, text: extra.text ?? 'Built it.', error: null, reviewId: null })
  return { dir, project, sent, ap, done }
}

test('build out: the first plan covers the whole game to launch, on Fable, and every piece is built on Fable', () => {
  const fable = { ok: true }
  const t = setup(fable)
  t.ap.start(t.project.id, { config: { sprintTasks: 0, buildOut: true, fastStart: true, checkIns: true } as never })
  const first = t.sent.at(-1)!
  assert.match(first.prompt, /^Autopilot: plan sprint 1 \(full game start\)/)
  assert.ok(first.prompt.includes(LAUNCH_PLAN) && first.prompt.includes(BUILD_OUT))
  assert.doesNotMatch(first.prompt, /fast MVP|playable MVP as fast/)
  assert.equal(first.model, BUILD_OUT_MODEL)
  t.done(first.prompt, first.agent, {
    text: plan([
      { agent: 'scripter', title: 'Core loop', brief: 'Rounds.', files: ['src/server/Rounds.luau'], size: 'hard' },
      { agent: 'ui-builder', title: 'Coin label', brief: 'Show coins.', files: ['src/client/Coins.luau'], size: 'simple' }
    ])
  })
  const items = t.sent.slice(-2)
  assert.deepEqual(items.map((i) => i.model), [BUILD_OUT_MODEL, BUILD_OUT_MODEL], 'simple pieces too: no Sonnet while building out')
  assert.ok(items.every((i) => !/fast MVP/.test(i.prompt)), 'pieces get the full QA pass, not the quick MVP check')
})

test('build out: without room on the plan for Fable, planning and building run on Opus 5.5', () => {
  const t = setup({ ok: false })
  t.ap.start(t.project.id, { config: { sprintTasks: 0, buildOut: true, fastStart: true, checkIns: true } as never })
  assert.equal(t.sent.at(-1)!.model, BUILD_OUT_FALLBACK)
  t.done(t.sent.at(-1)!.prompt, t.sent.at(-1)!.agent, { text: plan([{ agent: 'scripter', title: 'Core', brief: 'b', files: ['src/server/A.luau'], size: 'simple' }]) })
  assert.equal(t.sent.at(-1)!.model, BUILD_OUT_FALLBACK)
})

test('build out: off, nothing changes (MVP start, simple pieces on Sonnet)', () => {
  const t = setup({ ok: true })
  t.ap.start(t.project.id, { config: { sprintTasks: 0, fastStart: true, checkIns: true } as never })
  assert.match(t.sent.at(-1)!.prompt, /fast MVP start/)
  t.done(t.sent.at(-1)!.prompt, t.sent.at(-1)!.agent, { text: plan([{ agent: 'scripter', title: 'Core', brief: 'b', files: ['src/server/A.luau'], size: 'simple' }]) })
  assert.equal(t.sent.at(-1)!.model, SIMPLE_MODEL)
})

test('build out: sprints plan up to 6 pieces, and the mode turns itself off once only your launch tasks are left', () => {
  assert.equal(sprintMax({ sprintTasks: 0, buildOut: true }), 6)
  assert.equal(sprintMax({ sprintTasks: 3, buildOut: true }), 3, 'never more than you set')
  const t = setup({ ok: true })
  writeFileSync(join(t.dir, CHECKLIST), '# Ship\n## Game\n- [x] Core loop\n- [ ] (you) Two players\n## Store page (you)\n- [ ] Icon\n')
  t.ap.start(t.project.id, { config: { sprintTasks: 0, buildOut: true, fastStart: false, parallel: false, checkIns: true } as never })
  const step = t.sent.at(-1)!
  assert.equal(step.model, BUILD_OUT_MODEL, 'the Lead leads on Fable too')
  t.done(step.prompt, step.agent, { text: 'Done.\nSprint complete.' })
  t.done(t.sent.at(-1)!.prompt, t.sent.at(-1)!.agent, { origin: 'autopilot-report', text: '## Built\n- Core loop' })
  assert.equal(t.ap.get(t.project.id).config.buildOut, false)
})

test('Fable headroom: a margin under your plan limits; API keys use budgets instead', () => {
  const limits = { fiveHourPct: 90, weeklyPct: 80 }
  const usage = (five: number, week: number) => ({ fiveHour: { usedPct: five, resetsAt: null, at: 1 }, weekly: { usedPct: week, resetsAt: null, at: 1 }, blocked: null })
  assert.equal(fableHeadroom(usage(20, 30), limits), true)
  assert.equal(fableHeadroom(usage(70, 30), limits), false, '5-hour window: at most 70%')
  assert.equal(fableHeadroom(usage(20, 60), limits), false, 'weekly window: at most 60%')
  assert.equal(fableHeadroom(usage(50, 30), { fiveHourPct: 60, weeklyPct: 80 }), false, '20 points under your own limit')
  assert.equal(fableHeadroom({ fiveHour: null, weekly: null, blocked: { window: 'weekly', until: null } }, limits), false)
  assert.equal(fableHeadroom(null, limits), true, 'no report yet')
  assert.equal(fableHeadroom(usage(99, 99), null), true, 'API key')
})

test('new games build out the full game by default; the launch checklist asks for a complete game', () => {
  assert.equal(sanitizeNewGame({ name: 'G', parentDir: '/tmp', idea: 'x', autopilot: {} }).autopilot.buildOut, true)
  assert.equal(sanitizeNewGame({ name: 'G', parentDir: '/tmp', idea: 'x', autopilot: { buildOut: false } }).autopilot.buildOut, false)
  assert.match(SHIP_CHECKLIST, /complete game players come back to, not a demo/)
  assert.match(SHIP_CHECKLIST, /DataStoreService/)
  assert.match(SHIP_CHECKLIST, /## Reasons to come back/)
})
