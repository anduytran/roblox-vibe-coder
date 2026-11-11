import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Autopilot, piecesWanted, sprintMax, sprintMin } from '../src/main/autopilot'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates } from '../src/main/roles'

// The Lead plans enough pieces for every agent that can run at once ("Agents at once" in Settings), so none sits idle.

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const plan = (n: number): string =>
  `Plan.\n\`\`\`json\n${JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ agent: 'scripter', title: `P${i}`, brief: 'b', files: [`src/server/P${i}.luau`], size: 'hard' })) })}\n\`\`\``

function setup(maxRuns: number) {
  const dir = tmp('hangar-slots-')
  installTemplates(dir)
  mkdirSync(join(dir, 'design-vault'), { recursive: true })
  const registry = new ProjectRegistry(join(tmp('hangar-slots-reg-'), 'p.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const sent: { agent: string; prompt: string }[] = []
  const ap = new Autopilot({
    file: join(tmp('hangar-slots-a-'), 'a.json'),
    registry,
    reviews: new ReviewStore(join(tmp('hangar-slots-r-'), 'r.json')),
    costs: new CostTracker(join(tmp('hangar-slots-c-'), 'c.json')),
    emit: () => {},
    send: (_p, agent, prompt) => void sent.push({ agent, prompt }),
    merge: async () => {},
    maxRuns: () => maxRuns
  })
  return { project, sent, ap }
}

test('sprint size: at least one piece per agent that can run at once, never more than you set', () => {
  assert.equal(sprintMax({ sprintTasks: 0 }, false, 6), 6, 'the usual 4 rises to 6 agents at once')
  assert.equal(sprintMax({ sprintTasks: 0 }, false, 3), 4)
  assert.equal(sprintMax({ sprintTasks: 2 }, false, 6), 2, 'your own limit wins')
  assert.equal(sprintMin(6, 6), 6)
  assert.equal(sprintMin(2, 6), 2)
  assert.match(piecesWanted(3, 4), /^3–4 \(at least 3: Hangar runs 3 agents at once/)
  assert.match(piecesWanted(6, 6), /^6 \(at least 6/)
  assert.equal(piecesWanted(1, 4), '2–4', 'one agent at once: as before')
})

test('planning: the Lead is asked for a piece per agent at once, and a plan that big is kept whole', () => {
  const t = setup(6)
  const done = (prompt: string, text: string, origin: 'autopilot' | 'autopilot-report' = 'autopilot') =>
    t.ap.onTaskDone({ projectId: t.project.id, agentId: 'lead', task: { id: `t${t.sent.length}`, prompt, createdAt: 1, origin }, ok: true, stopped: false, text, error: null, reviewId: null })
  t.ap.start(t.project.id, { config: { sprintTasks: 0, fastStart: false, checkIns: true } as never })
  done(t.sent.at(-1)!.prompt, 'Set up.\nSprint complete.')
  done(t.sent.at(-1)!.prompt, '## Built\n- Setup', 'autopilot-report')
  t.ap.start(t.project.id)
  const p = t.sent.at(-1)!
  assert.match(p.prompt, /Pick the next 6 \(at least 6: Hangar runs 6 agents at once/)
  t.ap.onTaskDone({ projectId: t.project.id, agentId: p.agent, task: { id: 't', prompt: p.prompt, createdAt: 1, origin: 'autopilot' }, ok: true, stopped: false, text: plan(6), error: null, reviewId: null })
  assert.equal(t.ap.get(t.project.id).parallel?.items.length, 6)
})

test('planning: a new game\'s first plan fills every agent at once too', () => {
  const t = setup(5)
  t.ap.start(t.project.id, { config: { sprintTasks: 0, fastStart: true, checkIns: true } as never })
  assert.match(t.sent.at(-1)!.prompt, /Split the MVP into 5–6 \(at least 5: Hangar runs 5 agents at once/)
})
