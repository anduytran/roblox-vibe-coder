import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings } from '../src/shared/types'
import { AgentRunner, type ClipRecorder, type QueryFn } from '../src/main/agentRunner'
import { StudioClipRecorder } from '../src/main/clips'
import { CostTracker } from '../src/main/costs'
import { currentBranch } from '../src/main/git'
import { evaluateToolUse } from '../src/main/permissions'
import { DEFAULT_PROJECT_SETTINGS, ProjectRegistry } from '../src/main/projects'
import { ReviewActions } from '../src/main/reviewActions'
import { ReviewStore } from '../src/main/reviews'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPtfDwAEgwJ/1XUTpgAAAABJRU5ErkJggg==', 'base64')
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick()
  }
}

function setup(opts: { clips?: ClipRecorder; images?: boolean; during?: (cwd: string, g: (...a: string[]) => string) => void } = {}) {
  const dir = tmp('hangar-auto-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'game.luau'), 'print("v1")\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const registry = new ProjectRegistry(join(tmp('hangar-auto-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: true } })
  const reviews = new ReviewStore(join(tmp('hangar-auto-rv-'), 'reviews.json'))
  const events: AgentEvent[] = []
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 3, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const gates: (() => void)[] = []
  const authCalls: unknown[] = []
  const prompts: string[] = []
  let active = 0
  let maxActive = 0
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      prompts.push(prompt)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
        const cwd = options.cwd as string
        if (prompt.includes('change')) writeFileSync(join(cwd, `${prompt.replace(/\W+/g, '_')}.luau`), `-- ${prompt}\n`)
        opts.during?.(cwd, (...a: string[]) => execFileSync('git', a, { cwd }).toString())
        if (opts.images) {
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__Roblox_Studio__start_stop_play', input: {} }] } }
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shot1', name: 'mcp__Roblox_Studio__screen_capture', input: {} }] } }
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shot1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] } }
          // Images from other tools, or with a fake type, are ignored:
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'other', name: 'Read', input: {} }] } }
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'other', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] } }
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shot2', name: 'mcp__Roblox_Studio__screen_capture', input: {} }] } }
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shot2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('<script>not an image</script>').toString('base64') } }] }] } }
        }
        await new Promise<void>((r) => gates.push(r))
        if ((options.abortController as AbortController).signal.aborted) throw new Error('aborted')
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `Did: ${prompt}. Playtested, no errors.` }] } }
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.1 }
      } finally {
        active--
      }
    })()
  let runner!: AgentRunner
  runner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-auto-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test-key-123456',
    engineAuth: async (k, o) => {
      authCalls.push(o)
      return { env: { ANTHROPIC_API_KEY: k }, release: () => {} }
    },
    loadQuery: async () => query,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-auto-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-auto-t-'), 'trust.json'),
    appDataDir: '/fake/appdata',
    platform: 'linux',
    reviews,
    ...(opts.clips ? { clips: opts.clips } : {})
  })
  const actions = new ReviewActions({ registry, reviews, runner, emit: (e) => events.push(e), publisher: null })
  const status = (agentId: string) => runner.snapshot(project.id).find((a) => a.agentId === agentId)!.status
  return { dir, g, registry, project, runner, reviews, actions, events, gates, prompts, status, authCalls, maxActive: () => maxActive }
}

test('autonomous: each task runs on its own branch and ends as a review; the base branch is untouched', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'change the dash cooldown')
  await until(() => t.gates.length === 1)
  assert.match((await currentBranch(t.dir)) ?? '', /^hangar\/main-change-the-dash-cooldown-/)
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  const review = t.reviews.list()[0]!
  assert.equal(await currentBranch(t.dir), 'main', 'switched back to the base branch')
  assert.equal(existsSync(join(t.dir, 'change_the_dash_cooldown.luau')), false, 'work is not on main yet')
  assert.deepEqual(review.files, ['change_the_dash_cooldown.luau'])
  assert.match(review.summary, /Playtested, no errors/)
  assert.equal(review.incomplete, null)
  assert.match(await t.actions.diff(review.id), /\+-- change the dash cooldown/)
  assert.match(review.baseSha, /^[0-9a-f]{40}$/)
  assert.match(review.headSha, /^[0-9a-f]{40}$/)
  assert.match(t.g('log', '-1', '--format=%an', review.branch), /Hangar \(Main\)/)
  assert.ok(t.events.some((e) => e.type === 'review'))

  await t.actions.merge(review.id)
  assert.equal(readFileSync(join(t.dir, 'change_the_dash_cooldown.luau'), 'utf8'), '-- change the dash cooldown\n')
  assert.match(t.g('log', '-1', '--format=%an %s'), /^Me change the dash cooldown/)
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '', 'task branch deleted')
  await assert.rejects(t.actions.merge(review.id), /already merged/)
})

test('autonomous: tasks in one project run one at a time; discard deletes the branch', async () => {
  const t = setup()
  // Separate tasks (as autopilot sends them): each is its own change.
  t.runner.send(t.project.id, 'main', 'change one', { origin: 'autopilot' })
  t.runner.send(t.project.id, 'main', 'change two', { origin: 'autopilot' })
  await until(() => t.gates.length === 1)
  await tick(50)
  assert.equal(t.gates.length, 1, 'second task waits for the first')
  t.gates[0]!()
  await until(() => t.gates.length === 2)
  t.gates[1]!()
  await until(() => t.reviews.list().length === 2)
  assert.equal(t.maxActive(), 1)
  const second = t.reviews.list().find((r) => r.files.includes('change_two.luau'))!
  assert.deepEqual(second.files, ['change_two.luau'], 'each branch starts from the base, not from unreviewed work')
  await t.actions.discard(second.id)
  assert.equal(t.reviews.get(second.id).status, 'discarded')
  assert.equal(t.g('branch', '--list', second.branch).trim(), '')
})

test('autonomous: your unsaved edits are saved as a commit before a task starts, and review actions wait for running agents', async () => {
  const t = setup()
  writeFileSync(join(t.dir, 'game.luau'), 'print("my unsaved work")\n')
  t.runner.send(t.project.id, 'main', 'change y')
  await until(() => t.gates.length === 1)
  assert.match(t.g('log', 'main', '-1', '--format=%s'), /Changes made outside Hangar/, 'kept on main, not mixed into the task')
  assert.ok(t.runner.snapshot(t.project.id)[0]!.log.some((e) => /Saved 1 change made outside Hangar/.test(e.text)))
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  const r = t.reviews.list()[0]!
  assert.deepEqual(r.files, ['change_y.luau'], "the review holds only the agent's work")
  t.runner.send(t.project.id, 'main', 'change z')
  await until(() => t.gates.length === 2)
  await assert.rejects(t.actions.merge(r.id), /agent is working/)
  t.gates[1]!()
  // A follow-up in the same conversation: added to the same review.
  await until(() => t.reviews.get(r.id).messages === 2)
})

test('autonomous: a task that changes nothing leaves no branch or review; a stopped task is marked incomplete', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'just look around')
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.status('main') === 'idle' && !t.runner.projectBusy(t.project.id))
  assert.equal(t.reviews.list().length, 0)
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '')

  t.runner.send(t.project.id, 'main', 'change then stop')
  await until(() => t.gates.length === 2)
  t.runner.stop(t.project.id, 'main')
  t.gates[1]!()
  await until(() => t.reviews.list().length === 1)
  assert.match(t.reviews.list()[0]!.incomplete ?? '', /stopped/)
  assert.equal(await currentBranch(t.dir), 'main')
})

test('autonomous: prompt tells the agent how to work unattended; recorded tasks keep screenshot frames', async () => {
  const clipsDir = tmp('hangar-clips-')
  const t = setup({ clips: new StudioClipRecorder(clipsDir, 'linux'), images: true })
  t.runner.send(t.project.id, 'main', 'change with clip', { record: true })
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  const r = t.reviews.list()[0]!
  assert.equal(r.clip?.kind, 'frames')
  assert.equal(r.clip?.files.length, 1)
  assert.ok(r.clip!.files[0]!.startsWith(clipsDir), 'clips are stored in Hangar data, not the project')
  assert.ok(readFileSync(r.clip!.files[0]!).equals(PNG))
  assert.match(t.actions.clipFile(r.id, 0), /^data:image\/png;base64,/)
  assert.throws(() => t.actions.clipPath(r.id, 5))
  await t.actions.discard(r.id)
  assert.equal(existsSync(r.clip!.files[0]!), false, 'clip deleted with the review')
})

test('autonomous policy: edits and Studio playtest tools run freely; risky Studio tools and protected files still ask', () => {
  const s = { ...DEFAULT_PROJECT_SETTINGS, autonomous: true }
  const root = tmp('hangar-auto-pol-')
  const ev = (toolName: string, input: Record<string, unknown> = {}) => evaluateToolUse({ toolName, input, projectRoot: root, settings: s })
  assert.equal(ev('Edit', { file_path: 'src/a.luau' }).action, 'allow')
  for (const t of ['start_stop_play', 'character_navigation', 'user_keyboard_input', 'run_script_in_play_mode', 'get_console_output', 'screen_capture']) {
    assert.equal(ev(`mcp__Roblox_Studio__${t}`).action, 'allow', t)
  }
  for (const t of ['execute_luau', 'insert_asset', 'http_get', 'multi_edit', 'generate_mesh', 'upload_image']) {
    assert.equal(ev(`mcp__Roblox_Studio__${t}`).action, 'ask', t)
  }
  assert.equal(ev('Write', { file_path: '.mcp.json' }).action, 'ask')
  assert.equal(ev('Write', { file_path: '../outside.txt' }).action, 'ask')
  assert.equal(ev('WebFetch', { url: 'https://x.example' }).action, 'ask')
  assert.equal(evaluateToolUse({ toolName: 'mcp__Roblox_Studio__start_stop_play', input: {}, projectRoot: root, settings: { ...DEFAULT_PROJECT_SETTINGS } }).action, 'ask', 'not without autonomous mode')
  assert.equal(ev('Write', { file_path: 'src/.gitignore' }).action, 'ask', '.gitignore is protected')
})

test('audit: an agent moving main or other branches is undone, and the review only shows the task', async () => {
  const t = setup({
    during: (cwd, g) => {
      // Sneak a commit onto main without going through review.
      writeFileSync(join(cwd, 'evil.luau'), 'evil()\n')
      g('add', 'evil.luau')
      g('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'evil')
      const evil = g('rev-parse', 'HEAD').trim()
      g('update-ref', 'refs/heads/main', evil)
      g('branch', 'agent-made')
    }
  })
  const mainBefore = t.g('rev-parse', 'main').trim()
  t.runner.send(t.project.id, 'main', 'change sneaky')
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  assert.equal(t.g('rev-parse', 'main').trim(), mainBefore, 'main restored')
  assert.equal(t.g('branch', '--list', 'agent-made').trim(), '', 'new branches removed')
  const r = t.reviews.list()[0]!
  assert.match(r.note ?? '', /put them back/)
  assert.ok(r.files.includes('evil.luau'), 'the sneaky commit is part of the reviewed change, not hidden in main')
})

test('audit: if the agent leaves the project on main with conflicting changes, nothing is committed to main', async () => {
  const t = setup({
    during: (cwd, g) => {
      writeFileSync(join(cwd, 'game.luau'), 'print("task edit")\n')
      g('add', 'game.luau')
      g('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'task edit')
      g('checkout', '-q', 'main')
      writeFileSync(join(cwd, 'game.luau'), 'print("dirty on main")\n')
    }
  })
  const mainBefore = t.g('rev-parse', 'main').trim()
  t.runner.send(t.project.id, 'main', 'change conflict')
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.runner.snapshot(t.project.id)[0]!.log.some((e) => /couldn't switch back/.test(e.text)))
  assert.equal(t.g('rev-parse', 'main').trim(), mainBefore, 'main has no new commit')
  assert.equal(t.reviews.list().length, 0)
})

test('audit: merge applies exactly the reviewed commit; later changes to the branch are refused', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'change reviewed')
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  const r = t.reviews.list()[0]!
  t.g('checkout', '-q', r.branch)
  writeFileSync(join(t.dir, 'late.luau'), 'late()\n')
  t.g('add', '.')
  t.g('commit', '-qm', 'late')
  t.g('checkout', '-q', 'main')
  await assert.rejects(t.actions.merge(r.id), /changed after it was reviewed/)
})

test('audit: autonomous runs always hide the real API key from agents', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'look')
  await until(() => t.gates.length === 1)
  assert.deepEqual(t.authCalls[0], { forceHideKey: true })
  t.gates[0]!()
})

test('one conversation is one review: follow-ups add to it; after a merge, or for autopilot, a new one starts', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'change one')
  await until(() => t.gates.length === 1)
  t.gates[0]!()
  await until(() => t.reviews.list().length === 1)
  await until(() => !t.runner.projectBusy(t.project.id))
  t.runner.send(t.project.id, 'main', 'change two')
  await until(() => t.gates.length === 2)
  t.gates[1]!()
  await until(() => (t.reviews.list()[0]!.messages ?? 1) === 2)
  const [r] = t.reviews.list()
  assert.equal(t.reviews.list().length, 1, 'still one review')
  assert.deepEqual(r!.files.sort(), ['change_one.luau', 'change_two.luau'])
  assert.equal(r!.title, 'change one')
  assert.match(r!.summary, /Did: change two[\s\S]*Earlier in this conversation:[\s\S]*Did: change one/)
  assert.equal(await currentBranch(t.dir), 'main')
  await until(() => !t.runner.projectBusy(t.project.id))
  // Autopilot's own tasks are always their own review.
  t.runner.send(t.project.id, 'main', 'change three', { origin: 'autopilot' })
  await until(() => t.gates.length === 3)
  t.gates[2]!()
  await until(() => t.reviews.list().length === 2)
  await until(() => !t.runner.projectBusy(t.project.id))
  // Once merged, the next message starts a new change.
  await t.actions.merge(r!.id)
  t.runner.send(t.project.id, 'main', 'change four')
  await until(() => t.gates.length === 4)
  t.gates[3]!()
  await until(() => t.reviews.list().length === 3)
})
