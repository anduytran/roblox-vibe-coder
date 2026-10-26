import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings } from '../src/shared/types'
import { cleanAgentSettings, cleanMainAgent, disallowedFor, groupsFromTools, toolsFromGroups } from '../src/shared/agentConfig'
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

function runnerFor(dir: string) {
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
    getSettings: () => settings,
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
  assert.equal(m.disallowedTools, undefined)
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
  const can = o.canUseTool as CanUseTool
  const ac = new AbortController()
  assert.equal((await can('Edit', { file_path: join(dir, 'src', 'Shop.luau') }, { signal: ac.signal })).behavior, 'deny')
  assert.equal((await can('Edit', { file_path: join(dir, 'src', 'Shop.luau') }, { signal: ac.signal, agentID: 'sub-1' })).behavior, 'allow', 'the Scripter it hands work to can edit')
})
