import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, GameIdea, SprintReport, TrendsSnapshot } from '../src/shared/types'
import { checkinReply, phoneCheckin, phoneIdeas } from '../src/main/phoneData'
import { RemoteServer } from '../src/main/remote'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

const REPORT: SprintReport = {
  sprint: 3,
  at: 1000,
  spentUsd: 1.25,
  tasks: [
    { title: 'Gliding', outcome: 'merged' },
    { title: 'Shop', outcome: 'failed' }
  ],
  text: `Good sprint.

## Built
- Gliding

## Next sprint
1. Storms
2. Shop

## Questions for you
- Should storms damage parcels?
- Daily reward?`
}

const idea = (id: string, extra: Partial<GameIdea> = {}): GameIdea => ({
  id,
  title: `Idea ${id}`,
  pitch: 'Deliver parcels by glider.',
  coreLoop: '',
  whyNow: '',
  genre: 'Simulator',
  scope: 'small',
  inspiredBy: ['Sky Wars'],
  score: 71.6,
  ...extra
})

test('phone ideas: current, saved and trending, hidden characters shown, nothing the phone does not need', () => {
  const t: TrendsSnapshot = {
    fetchedAt: 5,
    games: [{ universeId: 1, placeId: 2, name: 'Obby‮txt.exe', genre: 'Obby', description: 'long', players: 1200, visits: 9, favorites: 1, likeRatio: 0.9, createdAt: null, updatedAt: null, lists: [], score: 64.4, demand: 70, parts: {} as never, growth: 0.123 }],
    genres: [
      { genre: 'Obby', score: 40, demand: 80, saturation: 70, games: 9, leader: 'x' },
      { genre: 'Tycoon', score: 66, demand: 70, saturation: 20, games: 3, leader: 'y' }
    ],
    ideas: [idea('a', { previous: idea('old') as never })],
    ideasAt: 5,
    error: null,
    saved: [idea('s', { detailed: true, coreLoop: 'Fly, deliver, upgrade.', features: ['Storms'] })]
  }
  const p = phoneIdeas(t)
  assert.equal(p.ideas[0]!.score, 72)
  assert.ok(!('previous' in p.ideas[0]!), 'no undo copy sent to the phone')
  assert.equal(p.saved[0]!.coreLoop, 'Fly, deliver, upgrade.')
  assert.deepEqual(
    p.genres.map((g) => g.genre),
    ['Tycoon', 'Obby'],
    'best spaces first'
  )
  assert.ok(!p.games[0]!.name.includes('‮') && p.games[0]!.name.includes('U+202E'), 'a direction override is shown, not obeyed')
  assert.ok(!('description' in p.games[0]!))
})

test('phone check-in: answers go back by position under the questions Hangar holds; the plan and notes follow', () => {
  const c = phoneCheckin(REPORT)
  assert.deepEqual(c.questions, ['Should storms damage parcels?', 'Daily reward?'])
  assert.equal(c.merged, 1)
  assert.equal(c.intro, 'Good sprint.')
  const r = checkinReply(REPORT, { answers: ['Only slow you down.', '', 'an extra answer with no question'], plan: ['Shop', ' Storms ', ''], notes: 'Keep it cozy.\u0007' })
  assert.equal(r.feedback, 'Answers to your questions:\nQ: Should storms damage parcels?\nA: Only slow you down.\n\nPlan for this sprint, in this order (the product owner edited it):\n1. Shop\n2. Storms\n\nOther notes:\nKeep it cozy.')
  assert.deepEqual(r.answers, [{ question: 'Should storms damage parcels?', answer: 'Only slow you down.' }])
  assert.equal(checkinReply(REPORT, { answers: [], plan: null, notes: '' }).feedback, '', 'an unchanged plan is not repeated back')
  assert.match(checkinReply(REPORT, { plan: [] }).feedback, /removed every item/)
  assert.throws(() => checkinReply(REPORT, { answers: ['x'.repeat(2000), 'y'.repeat(2000)], notes: 'z'.repeat(4000) }), /takes up to 8,000/)
  // The Lead's own plan items come back whole however long; only added ones are capped; at most 30 items.
  const long: SprintReport = { ...REPORT, text: REPORT.text.replace('1. Storms', '1. Storms ' + 'that push gliders off course '.repeat(15)) }
  const leadItem = phoneCheckin(long).next[0]!
  assert.ok(leadItem.length > 300)
  assert.ok(checkinReply(long, { plan: ['Shop', leadItem, 'n'.repeat(400)] }).feedback.includes(leadItem))
  assert.ok(!checkinReply(long, { plan: ['Shop', leadItem, 'n'.repeat(400)] }).feedback.includes('n'.repeat(301)))
  assert.throws(() => checkinReply(REPORT, { plan: Array.from({ length: 31 }, (_, i) => `item ${i}`) }), /30 items/)
  // A report without the sections: the notes are the whole reply.
  const plain: SprintReport = { ...REPORT, text: 'Did some work.' }
  assert.equal(phoneCheckin(plain).structured, false)
  assert.equal(checkinReply(plain, { notes: 'Thanks', answers: ['ignored'] }).feedback, 'Thanks')
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

function call(port: number, path: string, opts: { body?: unknown; token?: string } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const req = request(
      { host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, json })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

test('phone remote: ideas can be read and saved (the window hears about it); a check-in is answered once', async () => {
  const port = await freePort()
  const file = join(tmp('hangar-phone-'), 'remote.json')
  writeFileSync(file, JSON.stringify({ enabled: false, port, devices: [], vapid: null }))
  let snapshot: TrendsSnapshot = { fetchedAt: 1, games: [], genres: [], ideas: [idea('a'), idea('b')], ideasAt: 1, error: null, saved: [] }
  const trends = {
    current: () => snapshot,
    saveIdea: (id: string) => {
      const found = snapshot.ideas.find((i) => i.id === id)
      if (!found) throw new Error('That idea is no longer here.')
      return (snapshot = { ...snapshot, saved: [found, ...snapshot.saved] })
    },
    unsaveIdea: (id: string) => (snapshot = { ...snapshot, saved: snapshot.saved.filter((i) => i.id !== id) })
  }
  const events: AgentEvent[] = []
  const started: unknown[] = []
  const st = { status: 'checkin', sprint: 3, tasksDone: 2, config: { sprintTasks: 2 }, reason: null, awaitingReviewId: null, reports: [REPORT] }
  const autopilot = {
    get: () => st,
    start: (id: string, opts: unknown) => {
      started.push([id, opts])
      st.status = 'running'
      return st
    },
    pauseAll: () => {}
  }
  const registry = {
    list: () => [{ id: 'p1', name: 'Sky‮Courier', path: tmp('x-'), settings: { autonomous: true, testPlace: null } }],
    get: (id: string) => {
      if (id !== 'p1') throw new Error('Project not found.')
      return { path: tmp('x-') }
    }
  }
  const runner = { pendingApprovals: () => [], respond: () => {}, send: () => {}, stopAll: () => [], snapshot: () => [] }
  const reviews = {
    list: () => [{ id: 'r1', projectId: 'p1', agentId: 'main', title: 'Fix⁦ shop', status: 'pending', files: [], clip: null, research: null, createdAt: 1 }],
    mergeWarnings: () => []
  }
  const server = new RemoteServer(file, { registry, runner, reviews, costs: { summary: () => ({ todayUsd: 0, projectTodayUsd: {}, projectTotalUsd: {} }) }, autopilot, trends, emit: (e: AgentEvent) => events.push(e) } as any)
  await server.setEnabled(true)
  try {
    const { code } = server.startPairing()
    const token = (await call(port, '/api/pair', { body: { code } })).json.token
    const state = (await call(port, '/api/state', { token })).json
    assert.deepEqual(state.projects[0].autopilot.checkin.questions, ['Should storms damage parcels?', 'Daily reward?'])
    assert.ok(state.projects[0].name.includes('U+202E'), 'project names show hidden characters')
    assert.ok(state.reviews[0].title.includes('U+2066'), 'review titles show hidden characters')

    assert.equal((await call(port, '/api/ideas')).status, 401, 'needs a paired phone')
    const list = await call(port, '/api/ideas', { token })
    assert.equal(list.json.ideas.length, 2)
    const saved = await call(port, '/api/ideas/b/save', { token, body: {} })
    assert.deepEqual(
      saved.json.saved.map((i: { id: string }) => i.id),
      ['b']
    )
    assert.equal(events[0]?.type, 'trends', 'the desktop window is told')
    assert.equal((await call(port, '/api/ideas/nope/save', { token, body: {} })).status, 500)
    await call(port, '/api/ideas/b/unsave', { token, body: {} })
    assert.equal(snapshot.saved.length, 0)

    assert.equal((await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 2, at: 1000, answers: ['x'] } })).status, 409, 'an older check-in is refused')
    assert.equal((await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 3, at: 999, answers: ['x'] } })).status, 409, 'a replaced report of the same sprint is refused')
    assert.equal((await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 3, at: 1000, notes: 'n'.repeat(9000) } })).status, 200, 'notes are capped, not refused')
    st.status = 'checkin'
    started.length = 0
    assert.equal((await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 3, at: 1000, answers: ['x'.repeat(2000), 'y'.repeat(2000)], notes: 'z'.repeat(4000) } })).status, 400, 'too long for the Lead')
    assert.equal(started.length, 0)
    const ok = await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 3, at: 1000, answers: ['Only slow you down.'], plan: null, notes: '' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(started[0], ['p1', { feedback: 'Answers to your questions:\nQ: Should storms damage parcels?\nA: Only slow you down.', answers: [{ question: 'Should storms damage parcels?', answer: 'Only slow you down.' }] }])
    assert.equal((await call(port, '/api/autopilot/p1/checkin', { token, body: { sprint: 3, at: 1000, answers: ['again'] } })).status, 409, 'answered once')
    assert.equal((await call(port, '/api/autopilot/nope/checkin', { token, body: { sprint: 3 } })).status, 500, 'unknown project refused')
  } finally {
    server.stop()
  }
})

test('phone app: the page script parses and builds no HTML from strings', async () => {
  const { PHONE_FILES } = await import('../src/main/phoneApp')
  const js = PHONE_FILES['/app.js']!.body
  assert.doesNotThrow(() => new Function(js))
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  for (const tab of ['inbox', 'projects', 'ideas', 'settings']) assert.match(js, new RegExp(`navBtn\\('${tab}'`))
})

test('autopilot: a second check-in report for the same sprint (pause and resume while it was written) is ignored', async () => {
  const { Autopilot } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const registry = new ProjectRegistry(join(tmp('hangar-rep-'), 'p.json'))
  const project = registry.add(tmp('hangar-rep-proj-'))
  registry.update(project.id, { settings: { autonomous: true } })
  const ap = new Autopilot({
    file: join(tmp('hangar-rep-a-'), 'a.json'),
    registry,
    reviews: new ReviewStore(join(tmp('hangar-rep-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-rep-c-'), 'c.json')),
    emit: () => {},
    send: () => {},
    merge: async () => {
      throw new Error('no')
    }
  })
  ap.start(project.id)
  const report = (text: string): void =>
    ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: text, prompt: 'Autopilot: sprint 1 is over.', createdAt: 1, origin: 'autopilot-report' }, ok: true, stopped: false, text, error: null, reviewId: null })
  report('## Built\n- A\n## Questions\n- Stamina?')
  report('## Built\n- A\n## Questions\n- Delete the lobby?')
  const st = ap.get(project.id)
  assert.equal(st.status, 'checkin')
  assert.equal(st.reports.length, 1)
  assert.match(st.reports[0]!.text, /Stamina/)
  // Answered, then the late duplicate lands while sprint 2 builds: it's for a sprint that's over, so it's dropped.
  ap.start(project.id, { feedback: 'Yes to stamina.' })
  report('## Built\n- A\n## Questions\n- Delete the lobby?')
  assert.equal(ap.get(project.id).status, 'running')
  assert.equal(ap.get(project.id).reports.length, 1)
})
