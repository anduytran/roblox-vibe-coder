import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings } from '../src/shared/types'
import { AgentRunner, type CanUseTool, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { installTemplates } from '../src/main/roles'
import { convertMessage } from '../src/main/sdkMessages'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick()
  }
}

function setup(opts: { max?: number; key?: string | null; daily?: number | null } = {}) {
  const dir = tmp('hangar-run-proj-')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-run-'), 'projects.json'))
  const project = registry.add(dir)
  const costs = new CostTracker(join(tmp('hangar-run-'), 'costs.json'))
  const settings: AppSettings = {
    defaultModel: 'claude-sonnet-5-5',
    maxConcurrentRuns: opts.max ?? 2,
    perRunBudgetUsd: 1,
    globalDailyBudgetUsd: opts.daily === undefined ? null : opts.daily,
    studioMcpCommand: '',
    studioMcpArgs: []
  }
  const events: AgentEvent[] = []
  const calls: { prompt: string; options: Record<string, unknown>; release: () => void }[] = []
  let active = 0
  let maxActive = 0
  const query: QueryFn = ({ prompt, options }) => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    calls.push({ prompt, options, release })
    const n = calls.length
    return (async function* () {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        yield { type: 'system', subtype: 'init', session_id: `s-${n}`, model: 'm', mcp_servers: [] }
        if (prompt.includes('edit')) {
          const canUseTool = options.canUseTool as CanUseTool
          const ac = options.abortController as AbortController
          const r = await canUseTool('Edit', { file_path: 'src/x.luau' }, { signal: ac.signal })
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `edit ${r.behavior}` }] } }
        }
        await gate
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rojo build' } }] } }
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.25, num_turns: 2, session_id: `s-${n}` }
      } finally {
        active--
      }
    })()
  }
  const runner = new AgentRunner({
    registry,
    costs,
    getSettings: () => settings,
    getApiKey: () => (opts.key === undefined ? 'sk-ant-test-key-123456' : opts.key),
    loadQuery: async () => query,
    emit: (e) => events.push(e),
    persistFile: join(tmp('hangar-run-'), 'agents.json')
  })
  const status = (agentId: string) => runner.snapshot(project.id).find((a) => a.agentId === agentId)!.status
  return { runner, project, registry, costs, events, calls, status, maxActive: () => maxActive }
}

test('agents list the main agent plus role files', () => {
  const { runner, project } = setup()
  assert.deepEqual(runner.snapshot(project.id).map((a) => a.agentId).sort(), ['lead', 'main', 'qa-tester', 'scripter', 'ui-builder'])
})

test('queues respect the concurrency limit and resume sessions', async () => {
  const { runner, project, calls, status, maxActive, costs } = setup({ max: 2 })
  runner.send(project.id, 'main', 'task 1')
  runner.send(project.id, 'scripter', 'task 2')
  runner.send(project.id, 'ui-builder', 'task 3')
  runner.send(project.id, 'main', 'task 4')
  await until(() => calls.length === 2)
  assert.equal(status('ui-builder'), 'queued')
  assert.equal(calls[1]!.options.cwd, project.path)
  assert.deepEqual(calls[1]!.options.settingSources, ['project'])
  assert.match(String((calls[1]!.options.systemPrompt as { append: string }).append), /Scripter/)
  assert.equal((calls[1]!.options.env as Record<string, string>).ANTHROPIC_API_KEY, 'sk-ant-test-key-123456')

  calls[0]!.release()
  await until(() => calls.length === 3)
  // ui-builder's task (older) runs before main's second task
  assert.equal(calls[2]!.prompt, 'task 3')
  for (const c of calls) c.release()
  await until(() => calls.length === 4)
  assert.equal(calls[3]!.options.resume, 's-1', 'main resumes its earlier session')
  calls[3]!.release()
  await until(() => ['main', 'scripter', 'ui-builder'].every((a) => status(a) === 'idle'))
  assert.equal(maxActive(), 2)
  assert.equal(costs.summary().todayUsd, 1)
  const main = runner.snapshot(project.id).find((a) => a.agentId === 'main')!
  assert.ok(main.log.some((e) => e.kind === 'tool_use' && e.text === '$ rojo build'))
  assert.ok(main.log.some((e) => e.kind === 'result'))
})

test('approvals pause the agent and "always" is remembered', async () => {
  const { runner, project, registry, events, status, calls } = setup()
  runner.send(project.id, 'main', 'please edit')
  await until(() => status('main') === 'awaiting_approval')
  const req = runner.pendingApprovals()[0]!
  assert.equal(req.toolName, 'Edit')
  assert.ok(events.some((e) => e.type === 'approval'))
  runner.respond(req.id, 'always')
  await until(() => calls.length === 1 && status('main') === 'working')
  assert.deepEqual(registry.get(project.id).settings.alwaysAllowTools, ['Edit'])
  calls[0]!.release()
  await until(() => status('main') === 'idle')
  assert.ok(runner.snapshot(project.id)[0]!.log.some((e) => e.text === 'edit allow'))
})

test('stop denies pending approvals and marks the agent stopped', async () => {
  const { runner, project, status } = setup()
  runner.send(project.id, 'scripter', 'edit something')
  await until(() => status('scripter') === 'awaiting_approval')
  runner.stop(project.id, 'scripter')
  await until(() => status('scripter') === 'stopped')
  assert.equal(runner.pendingApprovals().length, 0)
})

test('missing key and spending limits stop runs before they start', async () => {
  const noKey = setup({ key: null })
  noKey.runner.send(noKey.project.id, 'main', 'hi')
  await until(() => noKey.status('main') === 'error')
  assert.equal(noKey.calls.length, 0)

  const broke = setup({ daily: 0.5 })
  broke.costs.record(broke.project.id, 'main', 1)
  broke.runner.send(broke.project.id, 'main', 'hi')
  await until(() => broke.status('main') === 'error')
  assert.match(broke.runner.snapshot(broke.project.id)[0]!.lastError ?? '', /limit/)
  assert.equal(broke.calls.length, 0)
})

test('stream messages convert to feed entries', () => {
  const init = convertMessage({ type: 'system', subtype: 'init', session_id: 'abc', mcp_servers: [{ name: 'Roblox_Studio', status: 'failed' }] })
  assert.equal(init.sessionId, 'abc')
  assert.match(init.entries[1]!.text, /Roblox Studio is not connected/)
  const res = convertMessage({ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 1.02 })
  assert.equal(res.finished?.ok, false)
  assert.match(res.entries[0]!.text, /per-run spending limit/)
  const tool = convertMessage({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(2000) }] }] } })
  assert.ok(tool.entries[0]!.text.length < 1000)
  assert.deepEqual(convertMessage({ type: 'something_new' }).entries, [])
})
