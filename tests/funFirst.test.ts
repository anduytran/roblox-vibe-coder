import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Autopilot, FAST_TRACK_MODEL, FUN_FIRST, FUN_QUESTIONS, MAKE_IT_FELT, PUSH_LIMITS, SIMPLE_MODEL, sprintMax } from '../src/main/autopilot'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates } from '../src/main/roles'
import { parseCheckin } from '../src/shared/checkin'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const plan = (items: unknown[]): string => `Plan.\n\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``
const has = (s: string, part: string): boolean => s.includes(part)

function setup(config: Record<string, unknown> = {}) {
  const dir = tmp('hangar-fun-')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-fun-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-fun-r-'), 'r.json'))
  const sent: { agent: string; prompt: string }[] = []
  const sentModels: (string | undefined)[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-fun-a-'), 'a.json'),
    registry,
    reviews,
    costs: new CostTracker(join(tmp('hangar-fun-c-'), 'c.json')),
    emit: () => {},
    send: (_p, agent, prompt, opts) => {
      sent.push({ agent, prompt })
      sentModels.push(opts.model)
    },
    merge: async () => {}
  })
  const done = (prompt: string, agent: string, extra: { text?: string; origin?: 'autopilot' | 'autopilot-report' } = {}) =>
    ap.onTaskDone({ projectId: project.id, agentId: agent, task: { id: `t${sent.length}`, prompt, createdAt: 1, origin: extra.origin ?? 'autopilot' }, ok: true, stopped: false, text: extra.text ?? 'Built it.', error: null, reviewId: null })
  ap.start(project.id, { config: { sprintTasks: 0, fastStart: false, checkIns: true, ...config } as never })
  return { project, sent, sentModels, ap, done }
}

test('fun first: sprint 1 aims at a playable core loop, and its check-in rates the game as a new player', () => {
  const t = setup()
  const first = t.sent.at(-1)!.prompt
  assert.ok(has(first, 'core loop a player can play from start to finish') && has(first, MAKE_IT_FELT))
  t.done(first, 'lead', { text: 'Set up.\nSprint complete.' })
  const report = t.sent.at(-1)!.prompt
  assert.match(report, /^Autopilot: sprint 1 is over/)
  // No wrap-up ran, so the check-in itself rates the game.
  assert.match(report, /## Fun check \(as a new player would feel what is merged now/)
  assert.ok(FUN_QUESTIONS.every((q) => has(report, q)))
  assert.match(report, /## Next sprint \([^)]*weakest fun answer first/)
})

test('fun first: the plan starts from the weakest fun answer, pieces are made felt, the wrap-up writes the fun check', () => {
  const t = setup()
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: 'Set up.\nSprint complete.' })
  t.done(t.sent.at(-1)!.prompt, 'lead', { origin: 'autopilot-report', text: '## Built\n- Setup\n## Next sprint\n- Bots' })
  t.ap.start(t.project.id)
  const planPrompt = t.sent.at(-1)!.prompt
  assert.match(planPrompt, /^Autopilot: plan sprint 2\b/)
  assert.ok(has(planPrompt, FUN_FIRST) && has(planPrompt, 'Fun Check.md (if there is one)'))
  t.done(planPrompt, 'planner', { text: plan([{ agent: 'scripter', title: 'Coins pop', brief: 'Coins pop when collected.', files: ['src/client/Coins.luau'] }]) })
  const item = t.sent.at(-1)!
  assert.match(item.prompt, /^Autopilot item \w+, sprint 2: Coins pop/)
  assert.ok(has(item.prompt, MAKE_IT_FELT))
  t.done(item.prompt, item.agent, { text: 'Blocked.' })
  const wrap = t.sent.at(-1)!.prompt
  assert.match(wrap, /^Autopilot: wrap up sprint 2\b/)
  assert.match(wrap, /Rewrite design-vault\/Fun Check\.md/)
  assert.ok(FUN_QUESTIONS.every((q) => has(wrap, q)))
  assert.match(wrap, /fix for the weakest answer first under "Next sprint"/)
  t.done(wrap, 'lead', { text: 'Wrapped.' })
  const report = t.sent.at(-1)!.prompt
  assert.match(report, /## Fun check \(copy the answers from design-vault\/Fun Check\.md/)
})

test('fun first: a fast MVP plan asks for feedback on the core action', () => {
  const t = setup({ fastStart: true })
  assert.match(t.sent.at(-1)!.prompt, /core loop playable from start to finish, with feedback a player can see or hear/)
})

test('check-in: the Fun check section is read on its own, and older check-ins have none', () => {
  const c = parseCheckin('## Built\n- Coins\n## Try it\nPress Play.\n## Fun check\n1. Goal clear: yes\n2. Feedback: partly, no sound\n## Next sprint\n- Coin sound\n## Questions for you\n- None')
  assert.match(c.fun, /Goal clear: yes[\s\S]*no sound/)
  assert.deepEqual(c.next, ['Coin sound'])
  assert.doesNotMatch(c.tryIt, /Goal/)
  assert.equal(parseCheckin('## Built\n- Coins\n## Next sprint\n- More').fun, '')
})

test('fast track: Fable plans, leads and builds the hard pieces, sprints plan up to 6 pieces, and plans push the limits', () => {
  const t = setup({ fastTrack: true })
  // Sprint 1 (one task at a time while the design is set up): the Lead works on Fable.
  assert.equal(t.sentModels.at(-1), FAST_TRACK_MODEL)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: 'Set up.\nSprint complete.' })
  t.done(t.sent.at(-1)!.prompt, 'lead', { origin: 'autopilot-report', text: '## Built\n- Setup\n## Next sprint\n- Bots' })
  t.ap.start(t.project.id)
  const planPrompt = t.sent.at(-1)!.prompt
  assert.ok(has(planPrompt, PUSH_LIMITS) && has(planPrompt, 'Pick the next 2–6 most valuable pieces'))
  assert.equal(t.sentModels.at(-1), FAST_TRACK_MODEL)
  t.done(planPrompt, 'planner', {
    text: plan([
      { agent: 'scripter', title: 'Boss fight', brief: 'A boss.', files: ['src/server/Boss.luau'], size: 'hard' },
      { agent: 'ui-builder', title: 'Coin colour', brief: 'Gold coins.', files: ['src/client/Hud.luau'], size: 'simple' }
    ])
  })
  const models = Object.fromEntries(t.sent.slice(-2).map((s, i) => [s.agent, t.sentModels.at(-2 + i)]))
  assert.deepEqual(models, { scripter: FAST_TRACK_MODEL, 'ui-builder': SIMPLE_MODEL })
})

test('fast track off: the usual limit, the builders\' own models, no push-the-limits rule', () => {
  assert.equal(sprintMax({ sprintTasks: 0, fastTrack: false }), 4)
  assert.equal(sprintMax({ sprintTasks: 0, fastTrack: true }), 6)
  assert.equal(sprintMax({ sprintTasks: 3, fastTrack: true }), 3, 'never more than you set')
  const t = setup()
  assert.equal(t.sentModels.at(-1), undefined)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: 'Set up.\nSprint complete.' })
  t.done(t.sent.at(-1)!.prompt, 'lead', { origin: 'autopilot-report', text: '## Built\n- Setup\n## Next sprint\n- Bots' })
  t.ap.start(t.project.id)
  assert.ok(!has(t.sent.at(-1)!.prompt, PUSH_LIMITS) && has(t.sent.at(-1)!.prompt, 'Pick the next 2–4'))
})
