import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEntry } from '../src/shared/types'
import { groupFeed, runSummary, sizeLabel } from '../src/shared/feed'
import { convertMessage } from '../src/main/sdkMessages'

let n = 0
const e = (kind: LogEntry['kind'], text: string, extra: Partial<LogEntry> = {}): LogEntry => ({ id: `e${++n}`, ts: n, kind, text, ...extra })

test('feed: a tool call sits with its result; three or more in a row fold into a run', () => {
  const log = [
    e('user', 'Add a dash'),
    e('assistant', 'Looking at the movement code.'),
    e('tool_use', 'Read src/Dash.lua', { tool: 'Read', toolUseId: 'a' }),
    e('tool_result', 'local Dash = {}', { toolUseId: 'a' }),
    e('assistant', 'Now the edit.'),
    e('tool_use', 'Edit src/Dash.lua', { tool: 'Edit', toolUseId: 'b' }),
    e('tool_use', 'Read src/A.lua', { tool: 'Read', toolUseId: 'c' }),
    e('tool_use', 'Read src/B.lua', { tool: 'Read', toolUseId: 'd' }),
    // Parallel calls: results come back in any order.
    e('tool_result', 'B', { toolUseId: 'd' }),
    e('error', 'File not found', { toolUseId: 'c' }),
    e('tool_result', 'ok', { toolUseId: 'b' }),
    e('error', 'Stopped: a file write went through a link'),
    e('result', 'Done')
  ]
  const g = groupFeed(log)
  assert.deepEqual(
    g.map((x) => x.type),
    ['entry', 'entry', 'tool', 'entry', 'run', 'entry', 'entry']
  )
  const tool = g[2]!
  assert.ok(tool.type === 'tool' && tool.call.result?.text === 'local Dash = {}')
  const run = g[4]!
  assert.ok(run.type === 'run')
  assert.deepEqual(
    run.calls.map((c) => [c.use.text, c.result?.text]),
    [
      ['Edit src/Dash.lua', 'ok'],
      ['Read src/A.lua', 'File not found'],
      ['Read src/B.lua', 'B']
    ]
  )
  assert.equal(runSummary(run.calls), 'Read ×2, Edit')
  // An error with no tool id is the agent's own and stays a line of its own.
  assert.ok(g[5]!.type === 'entry' && g[5]!.entry.kind === 'error')
  // Every log entry appears exactly once.
  const seen = g.flatMap((x) => (x.type === 'entry' ? [x.entry] : x.type === 'tool' ? [x.call.use, x.call.result] : x.calls.flatMap((c) => [c.use, c.result]))).filter(Boolean)
  assert.equal(seen.length, log.length)
})

test('feed: logs saved before tool ids pair results in order; a result with no call stays a line', () => {
  const g = groupFeed([e('tool_result', 'orphan from a trimmed log'), e('tool_use', 'Bash ls', { tool: 'Bash' }), e('tool_result', 'a.lua'), e('tool_use', 'Bash pwd', { tool: 'Bash' })])
  assert.deepEqual(
    g.map((x) => x.type),
    ['entry', 'tool', 'tool']
  )
  assert.ok(g[1]!.type === 'tool' && g[1]!.call.result?.text === 'a.lua')
  assert.ok(g[2]!.type === 'tool' && g[2]!.call.result === null)
})

test('feed: sizes and summaries', () => {
  assert.equal(sizeLabel({ text: 'abc' }), '3 B')
  assert.equal(sizeLabel({ text: 'é' }), '2 B')
  assert.equal(sizeLabel({ text: 'x'.repeat(1536) }), '1.5 KB')
  assert.equal(sizeLabel({ text: 'clipped…', bytes: 40_960 }), '40.0 KB', 'the recorded full size wins over the clipped text')
  const calls = ['A', 'B', 'C', 'D', 'E'].map((t) => ({ use: e('tool_use', t, { tool: t }), result: null }))
  assert.equal(runSummary(calls), 'A, B, C, D, …')
})

test('feed: the SDK conversion records which call a result belongs to', () => {
  const use = convertMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/a.lua' } }] } } as never)
  assert.equal(use.entries[0]!.toolUseId, 'tu_1')
  const res = convertMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello', is_error: true }] } } as never)
  assert.equal(res.entries[0]!.kind, 'error')
  assert.equal(res.entries[0]!.toolUseId, 'tu_1')
  const big = convertMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'x'.repeat(40_000) }] } } as never)
  assert.equal(big.entries[0]!.bytes, 40_000, 'full size recorded before the text is clipped')
  assert.ok(big.entries[0]!.text.length < 2000)
})

test('feed: a result still finds its call after an approval line or a subagent\'s work in between', () => {
  const g = groupFeed([
    e('tool_use', '$ rojo build', { tool: 'Bash', toolUseId: 'a' }),
    e('system', 'Approved: $ rojo build'),
    e('tool_result', 'Built game.rbxl', { toolUseId: 'a' }),
    e('tool_use', 'Task: build the shop', { tool: 'Task', toolUseId: 't' }),
    e('tool_use', '↳ Read src/Shop.lua', { tool: 'Read', toolUseId: 's1' }),
    e('tool_result', '↳ local Shop = {}', { toolUseId: 's1' }),
    e('assistant', '↳ The shop is done.'),
    e('tool_result', 'Shop built and tested.', { toolUseId: 't' })
  ])
  // The Task's result arrives after its subagent's text, and joins the Task row instead of standing alone.
  assert.deepEqual(
    g.map((x) => x.type),
    ['tool', 'entry', 'tool', 'tool', 'entry']
  )
  assert.ok(g[0]!.type === 'tool' && g[0]!.call.result?.text === 'Built game.rbxl')
  assert.ok(g[2]!.type === 'tool' && g[2]!.call.use.toolUseId === 't' && g[2]!.call.result?.text === 'Shop built and tested.')
})

test("autopilot: removing its queued step pauses it and keeps that step's feedback for the next one", async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Autopilot } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
  const registry = new ProjectRegistry(join(tmp('hangar-q-'), 'p.json'))
  const project = registry.add(tmp('hangar-q-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: string[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-q-a-'), 'a.json'),
    registry,
    reviews: new ReviewStore(join(tmp('hangar-q-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-q-c-'), 'c.json')),
    emit: () => {},
    send: (_p, _a, prompt) => {
      sent.push(prompt)
    },
    merge: async () => {
      throw new Error('no')
    }
  })
  ap.start(project.id)
  ap.addFeedback(project.id, 'Make storms slower.')
  // Finish task 1 so the next step carries the feedback.
  ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: 't1', prompt: sent[0]!, createdAt: 1, origin: 'autopilot' }, ok: false, stopped: false, text: '', error: 'boom', reviewId: null })
  const step = sent[sent.length - 1]!
  assert.match(step, /Make storms slower/)
  ap.removedFromQueue(project.id, [{ id: 't2', prompt: step, createdAt: 2, origin: 'autopilot' }])
  const st = ap.get(project.id)
  assert.equal(st.status, 'paused')
  assert.match(st.reason ?? '', /by you/i, 'reads as your doing (no phone push, not listed as needing you)')
  assert.deepEqual(st.feedback, ['Make storms slower.'])
  ap.resume(project.id)
  assert.match(sent[sent.length - 1]!, /Make storms slower/, 'the next step gets it again')
  // A step that finishes has had its feedback.
  ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: 't3', prompt: sent[sent.length - 1]!, createdAt: 3, origin: 'autopilot' }, ok: true, stopped: false, text: 'Built it.', error: null, reviewId: null })
  assert.deepEqual(ap.get(project.id).feedback, [])
  assert.doesNotMatch(sent[sent.length - 1]!, /Make storms slower/, 'not handed over twice')
})

test('autopilot: feedback survives Stop all, a step that failed before running, and a restart while paused', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Autopilot } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
  const registry = new ProjectRegistry(join(tmp('hangar-q2-'), 'p.json'))
  const project = registry.add(tmp('hangar-q2-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: string[] = []
  const file = join(tmp('hangar-q2-a-'), 'a.json')
  const deps = {
    file,
    registry,
    reviews: new ReviewStore(join(tmp('hangar-q2-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-q2-c-'), 'c.json')),
    emit: () => {},
    send: (_p: string, _a: string, prompt: string) => {
      sent.push(prompt)
    },
    merge: async () => {
      throw new Error('no')
    }
  }
  const ap = new Autopilot(deps)
  ap.start(project.id)
  ap.addFeedback(project.id, 'Fewer coins.')
  const fail = (error: string): void =>
    ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: `t${sent.length}`, prompt: sent[sent.length - 1]!, createdAt: 1, origin: 'autopilot' }, ok: false, stopped: false, text: '', error, reviewId: null })
  // Task 1 fails with no feedback in it; the retry is handed "Fewer coins." and then hits the daily limit before running.
  fail('boom')
  assert.match(sent[sent.length - 1]!, /Fewer coins/)
  fail('Daily limit reached')
  assert.equal(ap.get(project.id).status, 'paused')
  assert.deepEqual(ap.get(project.id).feedback, ['Fewer coins.'], 'a step that failed gives its feedback back')
  ap.resume(project.id)
  assert.match(sent[sent.length - 1]!, /Fewer coins/)
  // Stop all while that step is still queued.
  ap.pauseAll('You stopped all agents.')
  ap.returnFeedback(project.id, [{ id: 'q', prompt: sent[sent.length - 1]!, createdAt: 2, origin: 'autopilot' }])
  assert.deepEqual(ap.get(project.id).feedback, ['Fewer coins.'])
  // Handed again after Resume, then Hangar closes while paused: a fresh start gives it back.
  ap.resume(project.id)
  ap.pause(project.id)
  assert.deepEqual(ap.get(project.id).feedback, [])
  const again = new Autopilot(deps)
  assert.deepEqual(again.get(project.id).feedback, ['Fewer coins.'])
})

test('autopilot: when the Lead decides, the sprint runs until it says "Sprint complete." (or a ceiling), not a fixed count', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Autopilot, LEAD_SPRINT_MAX } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
  const registry = new ProjectRegistry(join(tmp('hangar-lead-'), 'p.json'))
  const project = registry.add(tmp('hangar-lead-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: string[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-lead-a-'), 'a.json'),
    registry,
    reviews: new ReviewStore(join(tmp('hangar-lead-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-lead-c-'), 'c.json')),
    emit: () => {},
    send: (_p, _a, prompt) => {
      sent.push(prompt)
    },
    merge: async () => {
      throw new Error('no')
    }
  })
  ap.start(project.id, { config: { sprintTasks: 0 } as never })
  assert.equal(ap.get(project.id).config.sprintTasks, 0)
  assert.match(sent[0]!, /task 1\. /, 'no "of N"')
  assert.match(sent[0]!, /Sprint complete\./)
  const finish = (text: string): void =>
    ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: `t${sent.length}`, prompt: sent[sent.length - 1]!, createdAt: 1, origin: 'autopilot' }, ok: true, stopped: false, text, error: null, reviewId: null })
  finish('Built the island.')
  finish('Built the void kill.')
  assert.match(sent[sent.length - 1]!, /task 3\b/, 'keeps going while the plan is unfinished')
  finish('Built respawn.\n\n**Sprint complete.**')
  assert.match(sent[sent.length - 1]!, /sprint 1 is over/, 'the Lead said so: check-in')
  // The ceiling stops a sprint that never ends.
  const st = ap.get(project.id)
  ;(ap as unknown as { put: (s: typeof st) => void }).put({ ...st, status: 'running', tasksDone: LEAD_SPRINT_MAX - 1, sprintDoneSaid: false })
  finish('One more thing.')
  assert.match(sent[sent.length - 1]!, /sprint 1 is over/)
})

test("autopilot: the Lead hands building to the Scripter/UI Builder and ends each task with the QA Tester's playtest", async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Autopilot } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const { installTemplates } = await import('../src/main/roles')
  const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
  const make = (withRoles: boolean) => {
    const registry = new ProjectRegistry(join(tmp('hangar-team-'), 'p.json'))
    const dir = tmp('hangar-team-proj-')
    if (withRoles) installTemplates(dir)
    const project = registry.add(dir)
    registry.update(project.id, { settings: { autonomous: true } })
    const sent: string[] = []
    const ap = new Autopilot({
      file: join(tmp('hangar-team-a-'), 'a.json'),
      registry,
      reviews: new ReviewStore(join(tmp('hangar-team-r-'), 'r.json')),
      costs: new CostTracker(join(tmp('hangar-team-c-'), 'c.json')),
      emit: () => {},
      send: (_p, _a, prompt) => {
        sent.push(prompt)
      },
      merge: async () => {
        throw new Error('no')
      }
    })
    ap.start(project.id)
    return sent[0]!
  }
  const team = make(true)
  assert.match(team, /hand the building to "scripter"[\s\S]*"ui-builder"/)
  assert.match(team, /hand "qa-tester" a playtest/)
  const alone = make(false)
  assert.doesNotMatch(alone, /qa-tester|scripter/)
})

test('unattended: check-ins answer themselves, unmergeable work waits for the morning, and the run ends on time', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Autopilot, AWAY_FEEDBACK } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
  const registry = new ProjectRegistry(join(tmp('hangar-away-'), 'p.json'))
  const project = registry.add(tmp('hangar-away-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-away-r-'), 'r.json'))
  const sent: string[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-away-a-'), 'a.json'),
    registry,
    reviews,
    costs: new CostTracker(join(tmp('hangar-away-c-'), 'c.json')),
    emit: () => {},
    send: (_p, _a, prompt) => {
      sent.push(prompt)
    },
    merge: async () => {
      throw new Error('no')
    }
  })
  ap.start(project.id, { config: { sprintTasks: 1 } as never })
  ap.configure(project.id, { unattended: true, unattendedUntil: Date.now() + 3600_000, unattendedBudgetUsd: 20 })
  assert.equal(ap.isAway(project.id), true)
  const done = (prompt: string, extra: { reviewId?: string | null; text?: string; origin?: 'autopilot' | 'autopilot-report' } = {}): void =>
    ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: `t${sent.length}`, prompt, createdAt: 1, origin: extra.origin ?? 'autopilot' }, ok: true, stopped: false, text: extra.text ?? 'Built it.', error: null, reviewId: extra.reviewId ?? null })
  // Task 1 ends in a review that can't merge itself (no checks, no reviewer): it waits in Reviews, work goes on.
  const r = reviews.add({ projectId: project.id, agentId: 'lead', title: 'Storms', branch: 'hangar/lead-storms-abc123', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'Storms', files: ['s.luau'], incomplete: null, note: null })
  done(sent[0]!, { reviewId: r.id })
  ap.onReview(reviews.get(r.id))
  assert.match(sent[sent.length - 1]!, /sprint 1 is over/, 'not stuck waiting for you')
  assert.equal(ap.get(project.id).away!.leftForYou, 1)
  // The check-in answers itself and sprint 2 starts on the Lead's plan.
  done(sent[sent.length - 1]!, { origin: 'autopilot-report', text: '## Built\n- Storms\n## Next sprint\n- Shop\n## Questions\n- Daily reward?' })
  assert.equal(ap.get(project.id).sprint, 2)
  assert.equal(ap.get(project.id).status, 'running')
  assert.ok(sent[sent.length - 1]!.includes(AWAY_FEEDBACK.slice(0, 40)), 'the Lead is told to decide and record')
  assert.equal(ap.get(project.id).away!.sprints, 1)
  // Time's up: the next step stops, and the summary says why.
  ap.configure(project.id, { unattendedUntil: Date.now() - 1 })
  done(sent[sent.length - 1]!)
  const st = ap.get(project.id)
  assert.equal(st.status, 'paused')
  assert.match(st.reason ?? '', /unattended run finished: the time you set is up/)
  assert.ok(st.away!.endedAt)
  assert.equal(st.config.unattended, false)
})
