import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AutopilotState, Review } from '../src/shared/types'
import { Notifier } from '../src/main/notifier'
import { listVaultNotes, readVaultNote } from '../src/main/vault'
import { readableNote } from '../src/shared/text'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('notifications: only while Hangar is in the background, once per item, throttled, titles only', () => {
  let now = 1_000_000
  let focused = false
  let enabled = true
  const shown: { title: string; body: string }[] = []
  const n = new Notifier({ enabled: () => enabled, focused: () => focused, projectName: () => 'Sky Courier', show: (x) => shown.push(x), now: () => now })
  n.seed({ reviews: ['old'] })
  const approval = (id: string, dangerous = false): AgentEvent => ({ type: 'approval', request: { id, projectId: 'p', agentId: 'main', toolName: 'Bash', summary: '$ rm -rf secret-thing', inputJson: '{}', reason: '', dangerous, canAlwaysAllow: false, truncated: false, ts: now } })
  const review = (id: string, status: Review['status'] = 'pending'): AgentEvent => ({ type: 'review', review: { id, projectId: 'p', status } as Review })
  n.onEvent(approval('a1'))
  assert.deepEqual(shown, [{ title: 'Sky Courier needs you', body: 'An action is waiting for your approval.' }])
  assert.ok(!JSON.stringify(shown).includes('rm -rf'), 'no command text')
  n.onEvent(approval('a1'))
  n.onEvent(approval('a2'))
  assert.equal(shown.length, 1, 'same item never twice; same kind throttled for 30 s')
  now += 31_000
  n.onEvent(approval('a3', true))
  assert.equal(shown[1]!.body, 'A high-risk action is waiting for your approval.')
  n.onEvent(review('old'))
  n.onEvent(review('r1'))
  assert.equal(shown.length, 3)
  n.onEvent(review('r1'))
  const ap = (status: AutopilotState['status']): AgentEvent => ({ type: 'autopilot', state: { projectId: 'p', status, sprint: 2 } as AutopilotState })
  n.onEvent(ap('running'))
  n.onEvent(ap('checkin'))
  n.onEvent(ap('checkin'))
  assert.equal(shown.length, 4)
  assert.equal(shown[3]!.body, 'Sprint 2 check-in is ready.')
  focused = true
  now += 60_000
  n.onEvent(approval('a4'))
  enabled = false
  focused = false
  n.onEvent(approval('a5'))
  assert.equal(shown.length, 4, 'nothing while focused or turned off')
})

test('notifications: autopilot\'s own reviews stay quiet while it builds; "waiting" notifies without the reason', () => {
  let now = 1_000_000
  const shown: { title: string; body: string }[] = []
  const n = new Notifier({ enabled: () => true, focused: () => false, projectName: () => 'Sky Courier', show: (x) => shown.push(x), now: () => now })
  const ap = (status: AutopilotState['status'], reason: string | null = null): AgentEvent => ({ type: 'autopilot', state: { projectId: 'p', status, sprint: 1, reason } as AutopilotState })
  const review = (id: string, kind: Review['kind'] = 'code'): AgentEvent => ({ type: 'review', review: { id, projectId: 'p', status: 'pending', kind } as Review })
  n.onEvent(ap('running'))
  n.onEvent(review('r1'))
  assert.equal(shown.length, 0, 'autopilot merges its own tasks')
  n.onEvent(review('res', 'research'))
  assert.equal(shown[0]!.body, 'Web research is ready for you to check.')
  now += 31_000
  n.onEvent(ap('waiting', '“Steal the admin cookie” needs your review.'))
  assert.equal(shown[1]!.body, 'Autopilot is waiting for you to review a task.')
  assert.ok(!JSON.stringify(shown).includes('cookie'), 'no agent-written text')
  now += 31_000
  n.onEvent(ap('waiting', 'again'))
  assert.equal(shown.length, 2, 'only on the change to waiting')
  n.onEvent(review('r1'))
  assert.equal(shown.length, 2, 'a review already seen while building stays quiet')
  n.onEvent(ap('off'))
  n.onEvent(review('r2'))
  assert.equal(shown[2]!.body, 'A task is ready for you to review.')
})

test('design notes: plain notes only, in reading order; reading takes only listed notes and never follows links', () => {
  const root = tmp('hangar-vault-')
  const v = join(root, 'design-vault')
  mkdirSync(join(v, 'Mechanics'), { recursive: true })
  mkdirSync(join(v, '.obsidian'), { recursive: true })
  mkdirSync(join(v, 'Mechanics', 'deeper'), { recursive: true })
  mkdirSync(join(v, '_templates'), { recursive: true })
  for (const f of ['Inbox.md', 'Roadmap.md', 'Game Overview.md', 'Zeta.md', 'Mechanics/Gliding.md', 'Mechanics/_Index.md', 'Mechanics/_Template.md', 'Mechanics/deeper/Too deep.md', '_templates/Note.md', '.obsidian/plugin.md', 'notes.txt']) writeFileSync(join(v, f), `# ${f}`)
  const outside = tmp('hangar-vault-out-')
  writeFileSync(join(outside, 'secret.md'), 'SECRET')
  symlinkSync(join(outside, 'secret.md'), join(v, 'Linked.md'))
  assert.deepEqual(listVaultNotes(root, 'design-vault').map((n) => n.path), ['Roadmap.md', 'Game Overview.md', 'Mechanics/_Index.md', 'Mechanics/Gliding.md', 'Inbox.md', 'Zeta.md'])
  assert.equal(listVaultNotes(root, 'design-vault').find((n) => n.path === 'Mechanics/_Index.md')!.title, 'Mechanics', "a folder's index is titled after it")
  assert.equal(readVaultNote(root, 'design-vault', 'Roadmap.md'), '# Roadmap.md')
  assert.throws(() => readVaultNote(root, 'design-vault', 'Linked.md'), /not in the vault/)
  assert.throws(() => readVaultNote(root, 'design-vault', '../../etc/passwd'), /not in the vault/)
  assert.throws(() => readVaultNote(root, 'design-vault', '.obsidian/plugin.md'), /not in the vault/)
  assert.deepEqual(listVaultNotes(root, '../outside'), [])
  // A vault folder that is itself a link is not read.
  const root2 = tmp('hangar-vault2-')
  symlinkSync(v, join(root2, 'design-vault'))
  assert.deepEqual(listVaultNotes(root2, 'design-vault'), [])
  // A note swapped for a link after listing can't be read through it (O_NOFOLLOW where supported).
  if (process.platform !== 'win32') {
    rmSync(join(v, 'Zeta.md'))
    symlinkSync(join(outside, 'secret.md'), join(v, 'Zeta.md'))
    assert.throws(() => readVaultNote(root, 'design-vault', 'Zeta.md'))
  }
  assert.equal(readableNote('---\ntags: [x]\n---\n# Title\nSee [[Roadmap]] and [[Game Overview|the overview]].'), '# Title\nSee Roadmap and the overview.')
})

test('check-in answers are kept on the report they answer', async () => {
  const { Autopilot } = await import('../src/main/autopilot')
  const { ProjectRegistry } = await import('../src/main/projects')
  const { ReviewStore } = await import('../src/main/reviews')
  const { CostTracker } = await import('../src/main/costs')
  const dir = tmp('hangar-ans-')
  const registry = new ProjectRegistry(join(dir, 'p.json'))
  const projDir = tmp('hangar-ans-proj-')
  const project = registry.add(projDir)
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: string[] = []
  const ap = new Autopilot({
    file: join(dir, 'a.json'),
    registry,
    reviews: new ReviewStore(join(dir, 'r.json')),
    costs: new CostTracker(join(dir, 'c.json')),
    emit: () => {},
    send: (_p, _a, prompt) => {
      sent.push(prompt)
    },
    merge: async () => {
      throw new Error('no')
    }
  })
  // Put it in a check-in state the way it gets there: a finished sprint with a report.
  const st = ap.start(project.id)
  ;(ap as unknown as { put: (s: AutopilotState) => AutopilotState }).put({ ...st, status: 'checkin', reports: [{ sprint: 1, at: 1, text: '## Questions for you\n- Storms?', tasks: [], spentUsd: 0 }] })
  const next = ap.start(project.id, { feedback: 'Q: Storms?\nA: Only slow you down.', answers: [{ question: 'Storms?', answer: 'Only slow you down.' }] })
  assert.deepEqual(next.reports[0]!.answers, [{ question: 'Storms?', answer: 'Only slow you down.' }])
  assert.equal(next.sprint, 2)
})
