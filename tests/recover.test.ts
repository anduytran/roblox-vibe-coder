import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AppSettings } from '../src/shared/types'
import { AgentRunner, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { currentBranch } from '../src/main/git'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick()
  }
}

/** A project in autonomous mode and a way to start Hangar "again" on the same data, as after a restart. */
function setup() {
  const dir = tmp('hangar-rec-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'game.luau'), 'print("v1")\n')
  writeFileSync(join(dir, '.gitignore'), 'local.env\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const registry = new ProjectRegistry(join(tmp('hangar-rec-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-rec-rv-'), 'reviews.json'))
  const persistFile = join(tmp('hangar-rec-p-'), 'agents.json')
  const trustFile = join(tmp('hangar-rec-t-'), 'trust.json')
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 3, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  let started = 0
  // The agent writes a file if asked to "change" something, then never finishes: Hangar "closes" mid-task.
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
      if (prompt.includes('change')) writeFileSync(join(options.cwd as string, 'storm.luau'), '-- storms\n')
      started++
      await new Promise(() => {})
    })()
  const hangar = (): AgentRunner => {
    let runner!: AgentRunner
    runner = new AgentRunner({
      registry,
      costs: new CostTracker(join(tmp('hangar-rec-c-'), 'costs.json')),
      getSettings: () => settings,
      getApiKey: () => 'sk-ant-test-key-123456',
      engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
      loadQuery: async () => query,
      emit: (e) => {
        if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
      },
      persistFile,
      trustFile,
      appDataDir: tmp('hangar-rec-app-'),
      platform: 'linux',
      reviews
    })
    return runner
  }
  return { dir, g, project, reviews, hangar, started: () => started, persistFile }
}

test('restart mid-task: the work becomes a "stopped early" review and the project is back on main', async () => {
  const t = setup()
  const first = t.hangar()
  first.send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  assert.match((await currentBranch(t.dir)) ?? '', /^hangar\//)
  // Hangar closes here (the first runner never finishes). Next launch:
  const again = t.hangar()
  await again.recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
  assert.equal(existsSync(join(t.dir, 'storm.luau')), false, 'the work is on its branch, not on main')
  const [review] = t.reviews.list()
  assert.ok(review)
  assert.deepEqual(review.files, ['storm.luau'])
  assert.equal(review.incomplete, 'Hangar was closed while this task was running.')
  assert.equal(review.title, 'change the storms')
  assert.equal(t.g('status', '--porcelain').trim(), '')
  // Recovery happens once.
  await again.recoverInterrupted()
  assert.equal(t.reviews.list().length, 1)
  assert.ok(again.snapshot(t.project.id).find((a) => a.agentId === 'main')!.log.some((e) => /Hangar was closed while this task was running/.test(e.text)))
})

test('restart mid-task with nothing done: back on main, the empty branch is removed, no review', async () => {
  const t = setup()
  t.hangar().send(t.project.id, 'main', 'look around')
  await until(() => t.started() === 1)
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '')
  assert.equal(t.reviews.list().length, 0)
})

test('restart while wrapping up: a task branch with commits but no review becomes one', async () => {
  const t = setup()
  t.hangar().send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  const branch = (await currentBranch(t.dir))!
  // As if Hangar committed and switched back, then closed before making the review.
  t.g('add', '-A')
  t.g('commit', '-qm', 'wip')
  t.g('checkout', '-q', 'main')
  await t.hangar().recoverInterrupted()
  const [review] = t.reviews.list()
  assert.equal(review?.branch, branch)
  assert.deepEqual(review?.files, ['storm.luau'])
  assert.equal(await currentBranch(t.dir), 'main')
})

test('a project left on an empty task branch by an older Hangar is put back; one with work is left alone', async () => {
  const t = setup()
  t.g('checkout', '-q', '-b', 'hangar/lead-autopilot-sprint-1-task-1-of-5-abc123')
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '')

  // "Try it in Studio" on a reviewed branch (it has commits): not touched.
  t.g('checkout', '-q', '-b', 'hangar/main-reviewed-abc123')
  writeFileSync(join(t.dir, 'x.luau'), 'x')
  t.g('add', '.')
  t.g('commit', '-qm', 'x')
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'hangar/main-reviewed-abc123')
})

test('the record survives other agents saving, and nothing you changed while Hangar was closed is undone or moved', async () => {
  const t = setup()
  const first = t.hangar()
  first.send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  first.resetSession(t.project.id, 'lead') // another agent saves its state meanwhile
  // While Hangar is closed, you tag, branch and edit your own ignored file.
  t.g('tag', 'v1')
  t.g('branch', 'my-idea')
  writeFileSync(join(t.dir, 'local.env'), 'KEY=mine')
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
  assert.match(t.g('tag', '--list'), /v1/, 'your tag is kept')
  assert.match(t.g('branch', '--list', 'my-idea'), /my-idea/, 'your branch is kept')
  assert.equal(existsSync(join(t.dir, 'local.env')), true, 'your ignored file is not moved')
  const [review] = t.reviews.list()
  assert.match(review?.note ?? '', /left them as they are: .*(v1|my-idea)/)
  assert.match(review?.note ?? '', /local\.env/)
})

test('a recovery that fails (a git lock left behind) is tried again at the next launch', async () => {
  const t = setup()
  t.hangar().send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  writeFileSync(join(t.dir, '.git', 'index.lock'), '')
  await t.hangar().recoverInterrupted()
  assert.match((await currentBranch(t.dir)) ?? '', /^hangar\//, 'left as it was')
  assert.equal(t.reviews.list().length, 0)
  rmSync(join(t.dir, '.git', 'index.lock'))
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
  assert.equal(t.reviews.list().length, 1)
})

test('no task starts until recovery is done', async () => {
  const t = setup()
  t.hangar().send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  const again = t.hangar()
  const done = again.recoverInterrupted()
  again.send(t.project.id, 'main', 'look around')
  assert.equal(t.started(), 1, 'held while recovering')
  await done
  await until(() => t.started() === 2)
  assert.equal(t.reviews.list().length, 1, 'the interrupted task was wrapped up first')
})

test('a tag named like the main branch does not leave the project detached', async () => {
  const t = setup()
  t.g('tag', 'main')
  t.g('checkout', '-q', '-b', 'hangar/main-old-task-abc123')
  await t.hangar().recoverInterrupted()
  assert.equal(await currentBranch(t.dir), 'main')
})

test('recovery says what it found: uncommitted edits it committed, branches moved or deleted (with the commit to bring them back)', async () => {
  const t = setup()
  t.g('branch', 'my-feature')
  t.hangar().send(t.project.id, 'main', 'change the storms')
  await until(() => t.started() === 1)
  t.g('branch', '-D', 'my-feature') // deleted mid-task (by the agent, or by you)
  writeFileSync(join(t.dir, 'game.luau'), 'print("my edit")\n') // your edit while Hangar was closed
  await t.hangar().recoverInterrupted()
  const [review] = t.reviews.list()
  assert.deepEqual(review?.files.sort(), ['game.luau', 'storm.luau'])
  assert.match(review?.note ?? '', /Everything uncommitted .*2 files.* may include changes you made/)
  assert.match(review?.note ?? '', /my-feature deleted \(was [0-9a-f]{9}\).*git branch <name>/)
})

test('the agent moved main and left its branch empty: nothing is put back, but the feed says so', async () => {
  const t = setup()
  const first = t.hangar()
  first.send(t.project.id, 'main', 'look around')
  await until(() => t.started() === 1)
  // The agent switches to main and commits there, then Hangar closes.
  t.g('checkout', '-q', 'main')
  writeFileSync(join(t.dir, 'sneaky.luau'), 'x')
  t.g('add', '.')
  t.g('commit', '-qm', 'agent on main')
  const again = t.hangar()
  await again.recoverInterrupted()
  assert.equal(t.reviews.list().length, 0)
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '', 'the empty task branch is removed')
  const log = again.snapshot(t.project.id).find((a) => a.agentId === 'main')!.log.map((e) => e.text).join('\n')
  assert.match(log, /hadn't changed anything .* main moved \([0-9a-f]{9} → [0-9a-f]{9}\)/)
})
