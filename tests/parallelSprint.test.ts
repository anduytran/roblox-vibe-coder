import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Autopilot, parseSprintPlan } from '../src/main/autopilot'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates } from '../src/main/roles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const plan = (items: unknown[]): string => `Plan: two pieces at once.\n\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``

test('sprint plan: only builder roles, plain relative files, no two pieces sharing a file, at most the limit', () => {
  const builders = ['scripter', 'ui-builder']
  const items = parseSprintPlan(
    plan([
      { agent: 'scripter', title: 'Bots melee', brief: 'Make bots melee.', files: ['src/server/Bots.luau'] },
      { agent: 'ui-builder', title: 'Health​ bar', brief: 'A bar.', files: ['src/client/Hud.luau', '/etc/passwd', '../x'] },
      { agent: 'qa-tester', title: 'Not a builder', brief: 'x', files: [] },
      { agent: 'scripter', title: 'Shares a file', brief: 'x', files: ['src/server/Bots.luau'] },
      { agent: 'scripter', title: '', brief: 'no title' }
    ]),
    builders
  )
  assert.deepEqual(items.map((i) => i.title), ['Bots melee', 'Health bar'])
  assert.deepEqual(items[1]!.files, ['src/client/Hud.luau'])
  assert.deepEqual(parseSprintPlan('no plan here', builders), [])
  assert.deepEqual(parseSprintPlan('```json\n{not json\n```', builders), [])
  assert.equal(parseSprintPlan(plan([1, 2, 3, 4, 5].map((n) => ({ agent: 'scripter', title: `t${n}`, brief: 'b', files: [`f${n}`] }))), builders, 2).length, 2)
})

function setup() {
  const dir = tmp('hangar-par-')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-par-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-par-r-'), 'r.json'))
  const sent: { agent: string; prompt: string; model?: string }[] = []
  let ap!: Autopilot
  ap = new Autopilot({
    file: join(tmp('hangar-par-a-'), 'a.json'),
    registry,
    reviews,
    costs: new CostTracker(join(tmp('hangar-par-c-'), 'c.json')),
    emit: () => {},
    send: (_p, agent, prompt, opts) => {
      sent.push({ agent, prompt, model: opts.model })
    },
    merge: async (id) => {
      ap.onReview(reviews.update(id, { status: 'merged' }))
    }
  })
  const done = (prompt: string, agent: string, extra: { text?: string; reviewId?: string | null; ok?: boolean; origin?: 'autopilot' | 'autopilot-report' } = {}) =>
    ap.onTaskDone({ projectId: project.id, agentId: agent, task: { id: `t${sent.length}`, prompt, createdAt: 1, origin: extra.origin ?? 'autopilot' }, ok: extra.ok ?? true, stopped: false, text: extra.text ?? 'Built it.', error: null, reviewId: extra.reviewId ?? null })
  // Sprint 1 (the very first) runs one task at a time while the Lead sets the design up; then its check-in.
  ap.start(project.id, { config: { sprintTasks: 0, fastStart: false } as never })
  done(sent.at(-1)!.prompt, 'lead', { text: 'Set up.\nSprint complete.' })
  done(sent.at(-1)!.prompt, 'lead', { origin: 'autopilot-report', text: '## Built\n- Setup\n## Next sprint\n- Bots\n- HUD' })
  return { project, reviews, sent, ap, done }
}

test('parallel sprint: the Lead plans, pieces go to their agents at once, changes merge as they pass, then a wrap-up and the check-in', () => {
  const t = setup()
  t.ap.start(t.project.id)
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot: plan sprint 2\b/)
  assert.equal(t.sent.at(-1)!.agent, 'planner', 'the Planner plans when the game has one')
  assert.match(t.sent.at(-1)!.prompt, /"scripter"/)
  t.done(
    t.sent.at(-1)!.prompt,
    'lead',
    {
      text: plan([
        { agent: 'scripter', title: 'Bots melee', brief: 'Bots use heavy melee. Criteria: knocks back 20 studs.', files: ['src/server/Bots.luau'] },
        { agent: 'ui-builder', title: 'Health bar', brief: 'Bottom-left bar.', files: ['src/client/Hud.luau'] }
      ])
    }
  )
  const items = t.sent.slice(-2)
  assert.deepEqual(items.map((s) => s.agent).sort(), ['scripter', 'ui-builder'], 'both pieces handed out at once')
  assert.ok(items.every((s) => /^Autopilot item \w+, sprint 2: /.test(s.prompt)))
  assert.match(items.find((s) => s.agent === 'scripter')!.prompt, /knocks back 20 studs[\s\S]*Files to work in: src\/server\/Bots\.luau[\s\S]*qa-tester/)
  const st = t.ap.get(t.project.id)
  assert.equal(st.parallel?.phase, 'building')
  // The UI piece builds nothing; the scripter's change passes its checks and merges itself.
  t.done(items.find((s) => s.agent === 'ui-builder')!.prompt, 'ui-builder', { text: 'Blocked: needs the product owner.' })
  assert.equal(t.ap.get(t.project.id).parallel?.phase, 'building', 'still waiting for the other piece')
  const r = t.reviews.add({ projectId: t.project.id, agentId: 'scripter', title: 'Bots melee', branch: 'hangar/scripter-bots-abc123', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'Bots melee', files: ['src/server/Bots.luau'], incomplete: null, note: null, clip: null })
  t.reviews.update(r.id, { checks: { status: 'done', reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed', output: '', ms: 1 }] } })
  t.done(items.find((s) => s.agent === 'scripter')!.prompt, 'scripter', { reviewId: r.id })
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      assert.equal(t.reviews.get(r.id).status, 'merged')
      // Everything decided: the Lead wraps up, then writes the check-in.
      const wrap = t.sent.at(-1)!
      assert.match(wrap.prompt, /^Autopilot: wrap up sprint 2\b[\s\S]*Bots melee \(scripter\): merged[\s\S]*Health bar \(ui-builder\): no-changes/)
      t.done(wrap.prompt, 'lead', { text: 'Roadmap updated.' })
      assert.match(t.sent.at(-1)!.prompt, /^Autopilot: sprint 2 is over/)
      t.done(t.sent.at(-1)!.prompt, 'lead', { origin: 'autopilot-report', text: '## Built\n- Bots melee\n## Next sprint\n- HUD' })
      const report = t.ap.get(t.project.id).reports.at(-1)!
      assert.deepEqual(report.tasks.map((x) => [x.title, x.outcome, !!x.wrapup]), [
        ['Health bar', 'no-changes', false],
        ['Bots melee', 'merged', false],
        ['Roadmap updated.', 'no-changes', true]
      ])
      resolve()
    }, 20)
  )
})

test('parallel sprint: without a usable plan the sprint goes one task at a time, as before', () => {
  const t = setup()
  t.ap.start(t.project.id)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: 'I think we should build bots next.' })
  assert.equal(t.ap.get(t.project.id).parallel?.phase, 'single')
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot, sprint 2, task 1\b/)
  assert.equal(t.sent.at(-1)!.agent, 'lead')
})

test('parallel sprint: off in the settings, the sprint goes one task at a time', () => {
  const t = setup()
  t.ap.start(t.project.id, { config: { parallel: false } as never })
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot, sprint 2, task 1\b/)
})

test('parallel sprint: while you are away, a piece that can\'t merge itself waits for you and the sprint carries on', () => {
  const t = setup()
  t.ap.configure(t.project.id, { unattended: true, unattendedUntil: null, unattendedBudgetUsd: 20 })
  // Turning it on at a check-in starts the next sprint on the Lead's own plan.
  if (t.ap.get(t.project.id).status !== 'running') t.ap.start(t.project.id)
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot: plan sprint 2\b/)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: plan([{ agent: 'scripter', title: 'Bots melee', brief: 'b', files: ['a.luau'] }]) })
  const item = t.sent.at(-1)!
  // No checks and no reviewer: nothing approves it, so it's left for the morning.
  const r = t.reviews.add({ projectId: t.project.id, agentId: 'scripter', title: 'Bots melee', branch: 'hangar/scripter-bots-def456', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'x', files: ['a.luau'], incomplete: null, note: null, clip: null })
  t.done(item.prompt, 'scripter', { reviewId: r.id })
  assert.equal(t.reviews.get(r.id).status, 'pending')
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot: wrap up sprint 2[\s\S]*Bots melee \(scripter\): waiting/)
  assert.equal(t.ap.get(t.project.id).away!.leftForYou, 1)
})

test('parallel sprint: pieces handed out but not started when Hangar closed are handed out again on Resume', () => {
  const t = setup()
  t.ap.start(t.project.id)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: plan([{ agent: 'scripter', title: 'Bots melee', brief: 'b', files: ['a.luau'] }]) })
  const before = t.sent.length
  // Hangar restarts: a new Autopilot on the same file, which pauses a running sprint.
  const again = new Autopilot({
    file: (t.ap as unknown as { deps: { file: string } }).deps.file,
    registry: (t.ap as unknown as { deps: { registry: ProjectRegistry } }).deps.registry,
    reviews: t.reviews,
    costs: new CostTracker(join(tmp('hangar-par-c2-'), 'c.json')),
    emit: () => {},
    send: (_p, agent, prompt) => {
      t.sent.push({ agent, prompt })
    },
    merge: async () => undefined
  })
  assert.equal(again.get(t.project.id).status, 'paused')
  assert.equal(again.get(t.project.id).parallel?.items[0]!.sent, false)
  again.resume(t.project.id)
  assert.equal(t.sent.length, before + 1)
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot item \w+, sprint 2: Bots melee/)
})

test('parallel sprint: several pieces for one role are built at the same time, each by its own lane', () => {
  const t = setup()
  t.ap.start(t.project.id)
  assert.match(t.sent.at(-1)!.prompt, /up to 3 pieces at the same time/)
  t.done(t.sent.at(-1)!.prompt, 'lead', {
    text: plan([
      { agent: 'scripter', title: 'Sprint and slide', brief: 'Sprint.', files: ['src/client/Sprint.luau'] },
      { agent: 'scripter', title: 'Ledge grab', brief: 'Grab.', files: ['src/client/Ledge.luau'] },
      { agent: 'ui-builder', title: 'HUD', brief: 'HUD.', files: ['src/client/Hud.luau'] }
    ])
  })
  const items = t.sent.slice(-3)
  assert.deepEqual(items.map((s) => s.agent).sort(), ['scripter', 'scripter~2', 'ui-builder'])
  assert.deepEqual(
    t.ap.get(t.project.id).parallel!.items.map((i) => [i.title, i.agentId, i.lane]),
    [
      ['Sprint and slide', 'scripter', 'scripter'],
      ['Ledge grab', 'scripter', 'scripter~2'],
      ['HUD', 'ui-builder', 'ui-builder']
    ]
  )
  // The second lane's piece finishing is matched to its item like any other.
  t.done(items.find((s) => s.agent === 'scripter~2')!.prompt, 'scripter~2', { text: 'Blocked.' })
  assert.equal(t.ap.get(t.project.id).parallel!.items.find((i) => i.title === 'Ledge grab')!.status, 'done')
})

test('auto-merge: low and medium concerns merge once the checks pass, and become a follow-up for the Lead', async () => {
  const { autoMergeBlocker } = await import('../src/main/autopilot')
  const t = setup()
  const passed = { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed' as const, output: '', ms: 1 }] }
  const base = { projectId: t.project.id, agentId: 'scripter', title: 'Ledge grab', branch: 'hangar/scripter-ledge-abc123', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'Ledge grab', files: ['src/client/Ledge.luau'], incomplete: null, note: null, clip: null }
  const concerns = (severity: 'low' | 'medium' | 'high') => ({ status: 'done' as const, verdict: 'concerns' as const, summary: 's', costUsd: 0, error: null, findings: [{ severity, file: 'src/client/Ledge.luau', line: 57, title: 'Ground probe hits other players', detail: 'x' }] })
  const r = t.reviews.add(base)
  assert.equal(autoMergeBlocker(t.reviews.update(r.id, { checks: passed, aiReview: concerns('medium') })), null)
  assert.match(autoMergeBlocker(t.reviews.update(r.id, { aiReview: concerns('high') })) ?? '', /serious problem/)
  assert.match(autoMergeBlocker(t.reviews.update(r.id, { checks: null, aiReview: concerns('low') })) ?? '', /no checks passed/)
  assert.match(autoMergeBlocker(t.reviews.update(r.id, { checks: passed, aiReview: { ...concerns('low'), verdict: 'block' as const } })) ?? '', /not to merge/)

  // In a sprint: the medium-concern change merges itself, and the Lead gets the concerns for next time.
  t.ap.start(t.project.id)
  t.done(t.sent.at(-1)!.prompt, 'lead', { text: plan([{ agent: 'scripter', title: 'Ledge grab', brief: 'Grab.', files: ['src/client/Ledge.luau'] }]) })
  const item = t.sent.at(-1)!
  const r2 = t.reviews.add({ ...base, title: 'Ledge grab works' })
  t.reviews.update(r2.id, { checks: passed, aiReview: concerns('medium') })
  t.done(item.prompt, 'scripter', { reviewId: r2.id })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(t.reviews.get(r2.id).status, 'merged')
  const st = t.ap.get(t.project.id)
  const followUp = [...st.feedback, ...(st.handedFeedback ?? [])].find((f) => /Follow-up from the reviewer agent/.test(f))
  assert.match(followUp ?? '', /"Ledge grab works".*Ground probe hits other players \(src\/client\/Ledge\.luau:57, medium\)/)
})

test('fast MVP start: Fable plans the first sprint, the team builds its pieces at once with a quick QA check', () => {
  const dir = tmp('hangar-mvp-')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-mvp-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-mvp-r-'), 'r.json'))
  const sent: { agent: string; prompt: string; model?: string }[] = []
  const ap = new Autopilot({ file: join(tmp('hangar-mvp-a-'), 'a.json'), registry, reviews, costs: new CostTracker(join(tmp('hangar-mvp-c-'), 'c.json')), emit: () => {}, send: (_p, agent, prompt, opts) => void sent.push({ agent, prompt, model: opts.model }), merge: async () => undefined })
  ap.start(project.id, { config: { sprintTasks: 0 } as never })
  const first = sent.at(-1)!
  assert.equal(first.agent, 'planner')
  assert.match(first.prompt, /^Autopilot: plan sprint 1 \(fast MVP start\)/)
  assert.match(first.prompt, /Game Overview\.md/)
  assert.equal(first.model, undefined, 'the Planner runs on its own model (Fable)')
  const items = [1, 2, 3, 4, 5].map((n) => ({ agent: n % 2 ? 'scripter' : 'ui-builder', title: `Piece ${n}`, brief: `Build piece ${n}.`, files: [`src/p${n}.luau`] }))
  ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: 't1', prompt: first.prompt, createdAt: 1, origin: 'autopilot' }, ok: true, stopped: false, text: plan(items), error: null, reviewId: null })
  const built = sent.filter((s) => s.prompt.startsWith('Autopilot item '))
  assert.equal(built.length, 5, 'more than the usual 4 pieces')
  assert.deepEqual([...new Set(built.map((b) => b.agent))].sort(), ['scripter', 'scripter~2', 'scripter~3', 'ui-builder', 'ui-builder~2'])
  assert.match(built[0]!.prompt, /fast MVP: speed matters/)
  assert.equal(built[0]!.model, undefined, 'builders keep their own models')
  assert.equal(ap.get(project.id).parallel?.mvp, true)
})

test('fast MVP start off: the Lead sets the design up first, one task at a time; a chosen planning model plans later sprints', () => {
  const t = setup()
  assert.doesNotMatch(t.sent[0]!.prompt, /fast MVP/)
  t.ap.configure(t.project.id, { plannerModel: 'claude-sonnet-5-5' })
  t.ap.start(t.project.id)
  assert.match(t.sent.at(-1)!.prompt, /^Autopilot: plan sprint 2\b/)
  assert.equal(t.sent.at(-1)!.model, 'claude-sonnet-5-5')
})

test('planner: without a Planner role, the Lead plans the MVP on Fable; games with a Lead get the Planner added', async () => {
  const { addLaterStarters, deleteRole, listRoles, ROLE_TEMPLATES } = await import('../src/main/roles')
  assert.equal(ROLE_TEMPLATES.find((r) => r.id === 'planner')!.model, 'claude-fable-5-1')
  const dir = tmp('hangar-noplan-')
  installTemplates(dir)
  deleteRole(dir, 'planner')
  deleteRole(dir, 'bookworm')
  const registry = new ProjectRegistry(join(tmp('hangar-noplan-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: { agent: string; model?: string }[] = []
  const ap = new Autopilot({ file: join(tmp('hangar-noplan-a-'), 'a.json'), registry, reviews: new ReviewStore(join(tmp('hangar-noplan-r-'), 'r.json')), costs: new CostTracker(join(tmp('hangar-noplan-c-'), 'c.json')), emit: () => {}, send: (_p, agent, _prompt, opts) => void sent.push({ agent, model: opts.model }), merge: async () => undefined })
  ap.start(project.id, { config: { sprintTasks: 0 } as never })
  assert.deepEqual(sent.at(-1), { agent: 'lead', model: 'claude-fable-5-1' })
  // An existing game with a Lead gets the Planner; one without the starter set doesn't.
  assert.deepEqual(addLaterStarters(dir), ['.claude/agents/planner.md', '.claude/agents/bookworm.md'])
  assert.ok(listRoles(dir).some((r) => r.id === 'planner'))
  assert.deepEqual(addLaterStarters(dir), [], 'only once')
  assert.deepEqual(addLaterStarters(tmp('hangar-bare-')), [])
})

test('planner: coordinates by default; the Lead and Planner are never builders', async () => {
  const { coordinatorFor } = await import('../src/main/agentRunner')
  const { ROLE_TEMPLATES } = await import('../src/main/roles')
  const planner = ROLE_TEMPLATES.find((r) => r.id === 'planner')!
  const c = coordinatorFor(planner, ROLE_TEMPLATES, 'knowledge/planner')!
  assert.ok(c.builders.includes('scripter') && c.builders.includes('ui-builder'))
  assert.ok(!c.builders.includes('lead') && !c.builders.includes('planner'))
  assert.deepEqual(c.notes, ['design-vault', 'knowledge/planner'])
})

test('planning prompts ask for short replies and briefs', () => {
  const t = setup()
  t.ap.start(t.project.id)
  const p = t.sent.at(-1)!.prompt
  assert.match(p, /at most 5 short lines/)
  assert.match(p, /at most 120 words/)
  assert.match(p, /ask "bookworm"/)
})
