import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings } from '../src/shared/types'
import { cleanAgentSettings, cleanMainAgent, disallowedFor, groupsFromTools, LEAN_DISALLOWED, toolsFromGroups } from '../src/shared/agentConfig'
import { AgentRunner, type CanUseTool, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { knowledgeFolder, knowledgeInstructions, knowledgeTitles, knowledgeUsable } from '../src/main/knowledge'
import { DEFAULT_PROJECT_SETTINGS, mcpServersFor, ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { parseRole, saveRole, serializeRole } from '../src/main/roles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 3, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: 'studio-mcp', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }

test('agent config: tool groups round-trip, and unticked groups become refused tools', () => {
  assert.equal(groupsFromTools(undefined).size, 4, 'no list = everything')
  assert.equal(toolsFromGroups(groupsFromTools(undefined)), undefined, 'everything ticked = no list')
  const qa = groupsFromTools(['Read', 'Glob', 'Grep'])
  assert.equal(qa.size, 0)
  const tools = toolsFromGroups(new Set(['web']))!
  assert.ok(tools.includes('Read') && tools.includes('WebFetch') && !tools.includes('Bash'))
  assert.deepEqual([...groupsFromTools(tools)], ['web'])
  const refused = disallowedFor(tools)
  for (const t of ['Edit', 'Write', 'Bash', 'Task', 'Agent']) assert.ok(refused.includes(t), t)
  assert.ok(!refused.includes('WebSearch') && !refused.includes('Read'))
  assert.deepEqual(disallowedFor(undefined), [])
})

test('agent config: settings from the window or a file are cleaned', () => {
  assert.deepEqual(cleanAgentSettings({ tools: ['Read', 'Bad Tool', 5, 'Read'], effort: 'extreme', budgetUsd: 500, studio: 'no', knowledge: '../etc' }), { tools: ['Read'], budgetUsd: 20 })
  assert.deepEqual(cleanAgentSettings({ effort: 'high', budgetUsd: '2.5', studio: false, knowledge: 'knowledge/lead' }), { effort: 'high', budgetUsd: 2.5, studio: false, knowledge: 'knowledge/lead' })
  assert.equal(cleanMainAgent({ prompt: '  ' }), undefined)
  assert.deepEqual(cleanMainAgent({ prompt: ' Be brief. ', effort: 'low' }), { effort: 'low', prompt: 'Be brief.' })
})

test('agent config: role files keep effort, budget, Studio and knowledge', () => {
  const role = { id: 'scripter', name: 'Scripter', description: 'd', prompt: 'p', effort: 'max' as const, budgetUsd: 3, studio: false, knowledge: 'notes/scripter' }
  const text = serializeRole(role)
  assert.match(text, /effort: max\nbudget: 3\nstudio: off\nknowledge: notes\/scripter/)
  const back = parseRole('scripter', text)!
  assert.equal(back.effort, 'max')
  assert.equal(back.budgetUsd, 3)
  assert.equal(back.studio, false)
  assert.equal(back.knowledge, 'notes/scripter')
  const odd = parseRole('x', '---\nname: X\neffort: huge\nbudget: -1\nstudio: on\nknowledge: /etc\n---\nhi')!
  assert.equal(odd.effort, undefined)
  assert.equal(odd.budgetUsd, undefined)
  assert.equal(odd.studio, undefined)
  assert.equal(odd.knowledge, undefined)
})

test('agent config: Studio can be turned off per agent', () => {
  const project = { id: 'p', name: 'P', path: '/x', settings: { ...DEFAULT_PROJECT_SETTINGS, robloxStudioMcp: true }, createdAt: 0 }
  assert.ok(mcpServersFor(project, settings, {}, {}).Roblox_Studio)
  assert.equal(mcpServersFor(project, settings, {}, { studio: false }).Roblox_Studio, undefined)
})

test('knowledge: a folder per agent, listed by name, never through a link', () => {
  const dir = tmp('hangar-kn-')
  assert.equal(knowledgeFolder('lead'), 'knowledge/lead')
  assert.equal(knowledgeFolder('lead', '../x'), 'knowledge/lead')
  assert.ok(knowledgeUsable(dir, 'knowledge/lead'), 'missing is fine: created with the first note')
  mkdirSync(join(dir, 'knowledge', 'lead', 'Systems'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'lead', 'Shop.md'), 'x')
  writeFileSync(join(dir, 'knowledge', 'lead', 'Systems', 'Storms.md'), 'x')
  writeFileSync(join(dir, 'knowledge', 'lead', 'Evil‮name.md'), 'x')
  writeFileSync(join(dir, 'knowledge', 'lead', 'skip.txt'), 'x')
  const list = knowledgeTitles(dir, 'knowledge/lead')
  assert.deepEqual(list.titles.sort(), ['Evilname.md', 'Shop.md', 'Systems/Storms.md'])
  const text = knowledgeInstructions('knowledge/lead', list, true)
  assert.match(text, /search it/)
  assert.match(text, /add or update one short note/)
  assert.doesNotMatch(knowledgeInstructions('knowledge/qa', { titles: [], more: 0 }, false), /add or update/)

  const outside = tmp('hangar-kn-out-')
  mkdirSync(join(dir, 'knowledge2'))
  symlinkSync(outside, join(dir, 'knowledge2', 'qa'))
  assert.equal(knowledgeUsable(dir, 'knowledge2/qa'), false)
  writeFileSync(join(dir, 'afile'), 'x')
  assert.equal(knowledgeUsable(dir, 'afile'), false)
})

function runnerFor(dir: string, app: AppSettings = settings) {
  const registry = new ProjectRegistry(join(tmp('hangar-ac-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { sandbox: false, robloxStudioMcp: true } })
  const calls: { prompt: string; options: Record<string, unknown> }[] = []
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  }
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-ac-c-'), 'costs.json')),
    getSettings: () => app,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e: AgentEvent) => {
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-ac-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-ac-t-'), 'trust.json'),
    appDataDir: tmp('hangar-ac-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-ac-rv-'), 'reviews.json'))
  })
  return { registry, project, runner, calls }
}

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('agent config: the runner applies each agent\'s tools, Studio, effort, budget and knowledge', async () => {
  const dir = tmp('hangar-ac-')
  saveRole(dir, { id: 'lead', name: 'Lead', description: 'plans', prompt: 'Lead here.', tools: toolsFromGroups(new Set(['delegate'])), effort: 'max', budgetUsd: 4, studio: false })
  saveRole(dir, { id: 'scripter', name: 'Scripter', description: 'code', prompt: 'Scripter here.', effort: 'low', studio: false })
  mkdirSync(join(dir, 'knowledge', 'lead'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'lead', 'Storm timing.md'), 'x')
  const t = runnerFor(dir)

  t.runner.send(t.project.id, 'lead', 'plan it')
  await until(() => t.calls.length === 1)
  const o = t.calls[0]!.options
  assert.equal(o.effort, 'max')
  assert.equal(o.maxBudgetUsd, 4)
  // Grep and Glob are offered, approved only inside the agent's own folder.
  const root = String(o.cwd).replace(/^\/+/, '')
  assert.deepEqual(o.allowedTools, [`Grep(//${root}/**)`, `Glob(//${root}/**)`])
  assert.equal((o.mcpServers as Record<string, unknown>).Roblox_Studio, undefined, 'Studio off for the Lead')
  for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch']) assert.ok((o.disallowedTools as string[]).includes(tool), tool)
  assert.ok(!(o.disallowedTools as string[]).includes('Task'))
  const append = (o.systemPrompt as { append: string }).append
  assert.match(append, /Your knowledge folder: knowledge\/lead\//)
  assert.match(append, /Storm timing\.md/)
  assert.doesNotMatch(append, /add or update one short note/, 'the Lead can\'t write files here')
  const sub = (o.agents as Record<string, Record<string, unknown>>).scripter!
  assert.equal(sub.effort, 'low')
  assert.ok((sub.disallowedTools as string[]).includes('mcp__Roblox_Studio'))
  assert.match(sub.prompt as string, /knowledge\/scripter\//)

  // The Lead's own limits don't block its helper; they do block the Lead.
  const can = o.canUseTool as CanUseTool
  const ac = new AbortController()
  assert.equal((await can('Bash', { command: 'ls' }, { signal: ac.signal })).behavior, 'deny')
  assert.equal((await can('mcp__Roblox_Studio__run_code', {}, { signal: ac.signal })).behavior, 'deny')
  assert.equal((await can('Read', { file_path: join(dir, 'x.luau') }, { signal: ac.signal, agentID: 'sub-1' })).behavior, 'allow')

  // Main uses the project's Main settings.
  t.registry.update(t.project.id, { settings: { mainAgent: { prompt: 'Always answer in haiku.', effort: 'high', budgetUsd: 2 } } })
  t.runner.send(t.project.id, 'main', 'hi')
  await until(() => t.calls.length === 2)
  const m = t.calls[1]!.options
  assert.equal(m.effort, 'high')
  assert.equal(m.maxBudgetUsd, 2)
  assert.ok((m.mcpServers as Record<string, unknown>).Roblox_Studio)
  assert.deepEqual(m.disallowedTools, LEAN_DISALLOWED, 'the Main agent with no tool limits: only the tools no agent needs are left out')
  assert.match((m.systemPrompt as { append: string }).append, /Always answer in haiku\./)
  assert.match((m.systemPrompt as { append: string }).append, /knowledge\/main\/[\s\S]*no notes yet \(the folder is created with your first note\)/)
})

test('coordinator: the Lead hands code and playtests to the team and only edits its own notes', async () => {
  const { coordinatorFor, coordinateBlock } = await import('../src/main/agentRunner')
  const { ROLE_TEMPLATES } = await import('../src/main/roles')
  const lead = ROLE_TEMPLATES.find((r) => r.id === 'lead')!
  const c = coordinatorFor(lead, ROLE_TEMPLATES, 'knowledge/lead')!
  assert.deepEqual(c.builders.sort(), ['scripter', 'studio-modeler', 'ui-builder'])
  assert.equal(c.qa, 'qa-tester')
  const root = '/game'
  assert.match(coordinateBlock(c, root, 'Edit', { file_path: '/game/src/server/Gun.luau' }) ?? '', /hand this change to "scripter"/)
  assert.equal(coordinateBlock(c, root, 'Write', { file_path: '/game/design-vault/Roadmap.md' }), null)
  assert.equal(coordinateBlock(c, root, 'Edit', { file_path: '/game/knowledge/lead/Shop.md' }), null)
  assert.match(coordinateBlock(c, root, 'Edit', { file_path: '/game/design-vault-evil/x.md' }) ?? '', /hand this change/)
  assert.match(coordinateBlock(c, root, 'mcp__Roblox_Studio__execute_luau', {}) ?? '', /hand playtesting to "qa-tester"/)
  assert.equal(coordinateBlock(c, root, 'Bash', { command: 'selene src' }), null)
  // Off when switched off, for other roles, or with nobody to hand work to.
  assert.equal(coordinatorFor({ ...lead, delegate: false }, ROLE_TEMPLATES, 'k'), null)
  assert.equal(coordinatorFor(ROLE_TEMPLATES.find((r) => r.id === 'scripter')!, ROLE_TEMPLATES, 'k'), null)
  assert.equal(coordinatorFor(lead, [lead], 'k'), null)
  // The setting round-trips through the role file.
  assert.equal(parseRole('lead', serializeRole({ ...lead, delegate: false }))!.delegate, false)
  assert.equal(parseRole('lead', serializeRole(lead))!.delegate, undefined, 'unset: on for the Lead by default')
})

test('coordinator: the runner refuses the Lead\'s own code edits but not its helpers\'', async () => {
  const dir = tmp('hangar-co-')
  const { installTemplates } = await import('../src/main/roles')
  installTemplates(dir)
  const t = runnerFor(dir)
  t.registry.update(t.project.id, { settings: { autoApproveEdits: true } })
  t.runner.send(t.project.id, 'lead', 'build the shop')
  await until(() => t.calls.length === 1)
  const o = t.calls[0]!.options
  assert.match((o.systemPrompt as { append: string }).append, /you coordinate, the team builds/)
  assert.match((o.systemPrompt as { append: string }).append, /names the exact files to read and change/)
  assert.match((o.agents as Record<string, { prompt: string }>).scripter!.prompt, /Read the files it names first and stay with them/)
  const can = o.canUseTool as CanUseTool
  const ac = new AbortController()
  assert.equal((await can('Edit', { file_path: join(dir, 'src', 'Shop.luau') }, { signal: ac.signal })).behavior, 'deny')
  assert.equal((await can('Edit', { file_path: join(dir, 'src', 'Shop.luau') }, { signal: ac.signal, agentID: 'sub-1' })).behavior, 'allow', 'the Scripter it hands work to can edit')
})

test('helpers: a role the Lead hands work to shows as working for it, with its steps in its own feed', async () => {
  const dir = tmp('hangar-help-')
  const { installTemplates } = await import('../src/main/roles')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-help-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { sandbox: false } })
  const events: AgentEvent[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const query: QueryFn = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { subagent_type: 'scripter', description: 'Build the shop server', prompt: 'Build it' } }] } }
      yield { type: 'assistant', parent_tool_use_id: 'call-1', message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Read', input: { file_path: join(dir, 'Shop.luau') } }] } }
      await gate
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Shop server done.' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-help-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-help-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-help-t-'), 'trust.json'),
    appDataDir: tmp('hangar-help-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-help-rv-'), 'reviews.json'))
  })
  const scripter = () => runner.snapshot(project.id).find((a) => a.agentId === 'scripter')!
  runner.send(project.id, 'lead', 'build the shop')
  await until(() => !!scripter().helping?.activity)
  assert.equal(scripter().helping!.forName, 'Lead')
  assert.equal(scripter().helping!.brief, 'Build the shop server')
  assert.match(scripter().helping!.activity!, /Shop\.luau/)
  assert.equal(scripter().status, 'idle', 'its own queue and status are untouched')
  const logs = () => events.filter((e) => e.type === 'log' && e.agentId === 'scripter').map((e) => (e as { entry: { text: string } }).entry.text)
  assert.ok(logs().some((t) => /^Working for Lead: Build the shop server/.test(t)))
  assert.ok(logs().some((t) => /Shop\.luau/.test(t) && !t.startsWith('↳')), 'its steps are in its own feed')
  release()
  await until(() => !scripter().helping)
  assert.ok(logs().some((t) => /Handed the work back to Lead/.test(t)))
})

test('helpers: one running in the background stays working until the engine says it is done', async () => {
  const dir = tmp('hangar-bg-')
  const { installTemplates } = await import('../src/main/roles')
  installTemplates(dir)
  const registry = new ProjectRegistry(join(tmp('hangar-bg-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { sandbox: false } })
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const query: QueryFn = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { subagent_type: 'scripter', description: 'Build safe ledges', prompt: 'Build it', run_in_background: true } }] } }
      yield { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'call-1', description: 'Build safe ledges', is_backgrounded: true }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Async agent launched successfully. It is running in the background.' }] } }
      yield { type: 'assistant', parent_tool_use_id: 'call-1', message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Read', input: { file_path: join(dir, 'Dash.luau') } }] } }
      await gate
      yield { type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'call-1', status: 'completed', output_file: '', summary: 'done' }
      await new Promise((r) => setTimeout(r, 20))
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-bg-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-bg-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-bg-t-'), 'trust.json'),
    appDataDir: tmp('hangar-bg-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-bg-rv-'), 'reviews.json'))
  })
  const scripter = () => runner.snapshot(project.id).find((a) => a.agentId === 'scripter')!
  runner.send(project.id, 'lead', 'safe ledges')
  await until(() => !!scripter().helping?.activity)
  assert.match(scripter().helping!.activity!, /Dash\.luau/, 'still working after the Agent call answered "launched"')
  release()
  await until(() => !scripter().helping)
  const lead = () => runner.snapshot(project.id).find((a) => a.agentId === 'lead')!
  await until(() => lead().status !== 'working')
})

test('max plan: no per-task dollar cap is given to the engine', async () => {
  const dir = tmp('hangar-max-')
  saveRole(dir, { id: 'scripter', name: 'Scripter', description: 'code', prompt: 'Scripter here.', budgetUsd: 3 })
  const t = runnerFor(dir, { ...settings, authMode: 'max' })
  t.runner.send(t.project.id, 'scripter', 'go')
  await until(() => t.calls.length === 1)
  assert.equal(t.calls[0]!.options.maxBudgetUsd, undefined)
  const api = runnerFor(dir)
  api.runner.send(api.project.id, 'scripter', 'go')
  await until(() => api.calls.length === 1)
  assert.equal(api.calls[0]!.options.maxBudgetUsd, 3, 'with an API key the cap stays')
})

test('costs: a resumed conversation counts only what the run added; autopilot steps start fresh', async () => {
  const dir = tmp('hangar-cost-')
  const registry = new ProjectRegistry(join(tmp('hangar-cost-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { sandbox: false } })
  const totals = [1.0, 1.5, 0.2, 1.8]
  const seen: { resume: unknown; session: string }[] = []
  let n = 0
  const query: QueryFn = ({ options }) =>
    (async function* () {
      const i = n++
      const session = options.resume ? String(options.resume) : `s${i}`
      seen.push({ resume: options.resume, session })
      yield { type: 'system', subtype: 'init', session_id: session, mcp_servers: [] }
      yield { type: 'result', subtype: 'success', total_cost_usd: totals[i] }
    })()
  const costs = new CostTracker(join(tmp('hangar-cost-c-'), 'costs.json'))
  const logs: string[] = []
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs,
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      if (e.type === 'log' && e.entry.kind === 'result') logs.push(e.entry.text)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-cost-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-cost-t-'), 'trust.json'),
    appDataDir: tmp('hangar-cost-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-cost-rv-'), 'reviews.json'))
  })
  const main = () => runner.snapshot(project.id).find((a) => a.agentId === 'main')!
  const run = async (prompt: string, origin?: 'autopilot') => {
    const before = n
    runner.send(project.id, 'main', prompt, origin ? { origin } : {})
    await until(() => n > before && main().status === 'idle')
  }
  await run('one')
  await run('two') // resumes s0, whose total goes 1.0 → 1.5
  assert.equal(seen[1]!.resume, 's0')
  assert.ok(Math.abs(costs.summary().todayUsd - 1.5) < 1e-9, `counted ${costs.summary().todayUsd}`)
  assert.match(logs[1]!, /\$0\.5000/, 'the feed shows what the run cost, not the running total')
  await run('autopilot step', 'autopilot') // a fresh conversation: 0.2
  assert.equal(seen[2]!.resume, undefined)
  assert.equal(main().sessionId, 's0', 'your own conversation with the agent is left where it was')
  await run('three') // back in s0: 1.5 → 1.8
  assert.equal(seen[3]!.resume, 's0')
  assert.ok(Math.abs(costs.summary().todayUsd - (1.5 + 0.2 + 0.3)) < 1e-9, `counted ${costs.summary().todayUsd}`)
})

test('context: a conversation far past its size (not summarized) starts over on the next message, and says so', async () => {
  const { CONTEXT_BACKSTOP } = await import('../src/main/agentRunner')
  const { autoContextTokens } = await import('../src/shared/agentConfig')
  const MAX_CONTEXT_TOKENS = autoContextTokens('main') * CONTEXT_BACKSTOP
  const dir = tmp('hangar-ctx-')
  const registry = new ProjectRegistry(join(tmp('hangar-ctx-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { sandbox: false } })
  const sizes = [40_000, MAX_CONTEXT_TOKENS + 10_000, 20_000]
  const resumes: unknown[] = []
  let n = 0
  const query: QueryFn = ({ options }) =>
    (async function* () {
      const i = n++
      resumes.push(options.resume)
      yield { type: 'system', subtype: 'init', session_id: options.resume ? String(options.resume) : `s${i}`, mcp_servers: [] }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: sizes[i]! - 10, cache_creation_input_tokens: 0 } } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 * (i + 1) }
    })()
  const logs: string[] = []
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-ctx-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit: (e) => {
      if (e.type === 'log') logs.push(e.entry.text)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-ctx-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-ctx-t-'), 'trust.json'),
    appDataDir: tmp('hangar-ctx-app-'),
    platform: 'linux',
    reviews: new ReviewStore(join(tmp('hangar-ctx-rv-'), 'reviews.json'))
  })
  const main = () => runner.snapshot(project.id).find((a) => a.agentId === 'main')!
  const run = async (prompt: string) => {
    const before = n
    runner.send(project.id, 'main', prompt)
    await until(() => n > before && main().status === 'idle')
  }
  await run('one') // 40k
  await run('two') // resumes, grows past the limit
  assert.equal(resumes[1], 's0')
  await run('three') // starts over
  assert.equal(resumes[2], undefined)
  assert.ok(logs.some((t) => /Started a new conversation: the last one had grown to \d+k tokens/.test(t)))
  assert.equal(main().sessionId, 's2')
})

test('context: each agent gets a context size for its job, which the engine summarizes down to', async () => {
  const { autoContextTokens, cleanContextTokens, contextTokensFor } = await import('../src/shared/agentConfig')
  assert.equal(autoContextTokens('lead'), 120_000)
  assert.equal(autoContextTokens('scripter'), 200_000)
  assert.equal(autoContextTokens('qa-tester'), 100_000)
  assert.equal(contextTokensFor('lead', 300_000), 300_000)
  assert.equal(cleanContextTokens('250k'), 250_000)
  assert.equal(cleanContextTokens(5), 100_000, 'the engine needs at least 100k')
  assert.equal(cleanContextTokens(5_000_000), 1_000_000)
  assert.equal(parseRole('x', serializeRole({ id: 'x', name: 'X', description: '', prompt: 'p', contextTokens: 180_000 }))!.contextTokens, 180_000)

  const dir = tmp('hangar-cw-')
  const { installTemplates } = await import('../src/main/roles')
  installTemplates(dir)
  const t = runnerFor(dir)
  t.runner.send(t.project.id, 'lead', 'plan')
  await until(() => t.calls.length === 1)
  const o = t.calls[0]!.options
  assert.equal((o.settings as { autoCompactWindow: number }).autoCompactWindow, 120_000)
  const agents = o.agents as Record<string, { autoCompactWindow: number }>
  assert.equal(agents.scripter!.autoCompactWindow, 200_000)
  assert.equal(agents['qa-tester']!.autoCompactWindow, 100_000)
  // QA's playtests have a turn limit; others keep the usual one.
  const turns = o.agents as Record<string, { maxTurns: number }>
  assert.equal(turns['qa-tester']!.maxTurns, 60)
  assert.equal(turns.scripter!.maxTurns, 80)
  assert.equal(o.maxTurns, 80)
  assert.equal(parseRole('qa', serializeRole({ id: 'qa', name: 'QA', description: '', prompt: 'p', maxTurns: 40 }))!.maxTurns, 40)
  t.runner.send(t.project.id, 'qa-tester', 'play it')
  await until(() => t.calls.length === 2)
  assert.equal(t.calls[1]!.options.maxTurns, 60, 'also when it runs on its own')
})

test('lanes: a second Scripter runs with the Scripter\'s settings, in its own lane', async () => {
  const { agentLabel, laneOf, roleOf } = await import('../src/shared/lanes')
  assert.equal(roleOf('scripter~2'), 'scripter')
  assert.equal(laneOf('scripter~2'), 2)
  assert.equal(laneOf('scripter'), 1)
  assert.equal(roleOf('scripter~x'), 'scripter~x', 'not a lane')
  assert.equal(agentLabel('scripter~3', () => 'Scripter'), 'Scripter (3)')
  const dir = tmp('hangar-lane-')
  saveRole(dir, { id: 'scripter', name: 'Scripter', description: 'code', prompt: 'Scripter here.', effort: 'low' })
  const t = runnerFor(dir)
  assert.throws(() => t.runner.send(t.project.id, 'scripter~4', 'x'), /Unknown agent/, 'at most 3 lanes')
  assert.throws(() => t.runner.send(t.project.id, 'nobody~2', 'x'), /Unknown agent/)
  t.runner.send(t.project.id, 'scripter', 'piece one')
  t.runner.send(t.project.id, 'scripter~2', 'piece two')
  await until(() => t.calls.length === 2)
  for (const c of t.calls) {
    assert.equal(c.options.effort, 'low', 'the role\'s settings')
    assert.match((c.options.systemPrompt as { append: string }).append, /# Your role: Scripter\nScripter here\./)
  }
  assert.ok(t.runner.snapshot(t.project.id).some((a) => a.agentId === 'scripter~2'), 'the lane shows next to its role')
  assert.equal(t.runner.agentName(t.project, 'scripter~2'), 'Scripter (2)')
})

test('search rules: Grep and Glob for one folder only, written as absolute rules', async () => {
  const { searchRules } = await import('../src/main/agentRunner')
  assert.deepEqual(searchRules('/var/folders/x/hangar-copies/p/qa-tester/'), ['Grep(//var/folders/x/hangar-copies/p/qa-tester/**)', 'Glob(//var/folders/x/hangar-copies/p/qa-tester/**)'])
  assert.deepEqual(searchRules('C:\\Games\\Sky'), ['Grep(//C:/Games/Sky/**)', 'Glob(//C:/Games/Sky/**)'])
})

test('bookworm: a cheap read-only reader that the agents are told to use for reading', async () => {
  const dir = tmp('hangar-bw-')
  const { installTemplates, ROLE_TEMPLATES } = await import('../src/main/roles')
  installTemplates(dir)
  const bw = ROLE_TEMPLATES.find((r) => r.id === 'bookworm')!
  assert.equal(bw.model, 'claude-haiku-5-5')
  const t = runnerFor(dir)
  t.runner.send(t.project.id, 'scripter', 'add a shop')
  await until(() => t.calls.length === 1)
  const o = t.calls[0]!.options
  assert.match((o.systemPrompt as { append: string }).append, /ask "bookworm" with the Agent tool/)
  const def = (o.agents as Record<string, { model: string; disallowedTools: string[] }>).bookworm!
  assert.equal(def.model, 'claude-haiku-5-5')
  for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch', 'Agent', 'mcp__Roblox_Studio']) assert.ok(def.disallowedTools.includes(tool), tool)
  // The Bookworm itself isn't told to ask itself.
  t.runner.send(t.project.id, 'bookworm', 'summarise the shop')
  await until(() => t.calls.length === 2)
  assert.doesNotMatch((t.calls[1]!.options.systemPrompt as { append: string }).append, /ask "bookworm"/)
})

test('leaner runs: medium effort by default (low for coordinators, Haiku keeps its usual), and tools no agent needs are left out', async () => {
  const { autoEffort, LEAN_DISALLOWED } = await import('../src/shared/agentConfig')
  assert.equal(autoEffort('claude-opus-5-5'), 'medium')
  assert.equal(autoEffort('claude-fable-5-1'), 'medium')
  assert.equal(autoEffort('claude-haiku-5-5'), undefined)
  const dir = tmp('hangar-lean-')
  const { installTemplates } = await import('../src/main/roles')
  installTemplates(dir)
  saveRole(dir, { id: 'scripter', name: 'Scripter', description: 'code', prompt: 'p', model: 'claude-opus-5-5', effort: 'high' })
  const t = runnerFor(dir)
  t.runner.send(t.project.id, 'lead', 'plan it')
  await until(() => t.calls.length === 1)
  const o = t.calls[0]!.options
  assert.equal(o.effort, 'low', 'the Lead coordinates, so it thinks at low unless it says otherwise')
  for (const tool of ['NotebookEdit', 'TodoWrite', 'AskUserQuestion', 'EnterPlanMode']) assert.ok((o.disallowedTools as string[]).includes(tool), tool)
  assert.ok(!(o.disallowedTools as string[]).includes('Read') && !(o.disallowedTools as string[]).includes('ToolSearch'))
  const agents = o.agents as Record<string, { effort?: string; disallowedTools: string[] }>
  assert.equal(agents.scripter!.effort, 'high', 'a role\'s own effort wins')
  assert.equal(agents['qa-tester']!.effort, undefined, 'Haiku keeps its usual')
  assert.equal(agents['ui-builder']!.effort, 'medium')
  assert.ok(LEAN_DISALLOWED.every((x) => agents['ui-builder']!.disallowedTools.includes(x)))
})

test('coordinators: smaller context and low effort by default; their own settings win', async () => {
  const { autoContextTokens, autoEffort } = await import('../src/shared/agentConfig')
  assert.equal(autoEffort('claude-fable-5-1', true), 'low')
  assert.equal(autoEffort('claude-opus-5-5'), 'medium')
  assert.equal(autoEffort('claude-haiku-5-5', true), undefined)
  assert.equal(autoContextTokens('fast-tracker', true), 120_000)
  assert.equal(autoContextTokens('fast-tracker'), 150_000)
  const dir = tmp('hangar-coord-')
  const { installTemplates, saveRole } = await import('../src/main/roles')
  installTemplates(dir)
  saveRole(dir, { id: 'fast-tracker', name: 'Fast Tracker', description: 'plans', prompt: 'Plan fast.', model: 'claude-fable-5-1', delegate: true })
  saveRole(dir, { id: 'big-planner', name: 'Big Planner', description: 'plans', prompt: 'Plan.', model: 'claude-fable-5-1', delegate: true, contextTokens: 300_000, effort: 'high' })
  const t = runnerFor(dir)
  t.runner.send(t.project.id, 'fast-tracker', 'plan the MVP')
  await until(() => t.calls.length === 1)
  assert.equal(t.calls[0]!.options.effort, 'low')
  assert.equal((t.calls[0]!.options.settings as { autoCompactWindow: number }).autoCompactWindow, 120_000)
  assert.match((t.calls[0]!.options.systemPrompt as { append: string }).append, /never one brief per problem/)
  t.runner.send(t.project.id, 'big-planner', 'plan')
  await until(() => t.calls.length === 2)
  assert.equal(t.calls[1]!.options.effort, 'high')
  assert.equal((t.calls[1]!.options.settings as { autoCompactWindow: number }).autoCompactWindow, 300_000)
})
