import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CostTracker } from '../src/main/costs'
import { gitCommit, gitDiff, gitRevertFile, gitStatus, parsePorcelain } from '../src/main/git'
import { mcpServersFor, ProjectRegistry, defaultStudioMcp } from '../src/main/projects'
import { installTemplates, listRoles, parseRole, saveRole, serializeRole } from '../src/main/roles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('role files round-trip in Claude Code format', () => {
  const text = serializeRole({ id: 'qa', name: 'QA Tester', description: 'Finds bugs: reports them', prompt: 'Do QA.', tools: ['Read', 'Grep'], model: 'claude-haiku-5-5' })
  const role = parseRole('qa', text)
  assert.deepEqual(role, { id: 'qa', name: 'QA Tester', description: 'Finds bugs: reports them', prompt: 'Do QA.', tools: ['Read', 'Grep'], model: 'claude-haiku-5-5' })
  assert.equal(parseRole('x', 'no frontmatter'), null)
  assert.deepEqual(parseRole('y', '---\nname: Y\ntools: [Read, "Edit"]\nmodel: inherit\n---\nHi')?.tools, ['Read', 'Edit'])
})

test('templates install once and roles save/list', () => {
  const dir = tmp('hangar-roles-')
  installTemplates(dir)
  installTemplates(dir)
  assert.deepEqual(listRoles(dir).map((r) => r.id).sort(), ['lead', 'qa-tester', 'scripter', 'ui-builder'])
  saveRole(dir, { id: '', name: 'Level Designer!', description: 'd', prompt: 'p' })
  assert.ok(listRoles(dir).some((r) => r.id === 'level-designer'))
  assert.throws(() => saveRole(dir, { id: '', name: '', description: '', prompt: '' }))
})

test('cost limits block new runs', () => {
  const costs = new CostTracker(join(tmp('hangar-costs-'), 'costs.json'))
  const now = Date.now()
  costs.record('p1', 'main', 1.5, now)
  costs.record('p2', 'main', 0.5, now)
  costs.record('p1', 'main', 9, now - 3 * 24 * 3600 * 1000)
  const s = costs.summary(now)
  assert.equal(s.todayUsd, 2)
  assert.equal(s.projectTotalUsd.p1, 10.5)
  assert.equal(costs.budgetBlock('p1', null, 5, now), null)
  assert.match(costs.budgetBlock('p1', null, 2, now) ?? '', /Daily spending limit/)
  assert.match(costs.budgetBlock('p1', 1, null, now) ?? '', /project's daily limit/)
  assert.equal(costs.budgetBlock('p2', 1, null, now), null)
})

test('project registry, settings sanitizing and MCP config', () => {
  const dir = tmp('hangar-proj-')
  const reg = new ProjectRegistry(join(tmp('hangar-reg-'), 'projects.json'))
  const p = reg.add(dir)
  assert.equal(reg.add(dir).id, p.id, 'adding the same folder twice returns the same project')
  const u = reg.update(p.id, { settings: { allowedBashPrefixes: ['  ls ', '', 'ls'], dailyBudgetUsd: -3 } })
  assert.deepEqual(u.settings.allowedBashPrefixes, ['ls'])
  assert.equal(u.settings.dailyBudgetUsd, null)
  assert.throws(() => reg.add(join(dir, 'missing')))

  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] }, bad: { nope: 1 } } }))
  const app = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '/custom/StudioMCP', studioMcpArgs: [] }
  const servers = mcpServersFor(reg.get(p.id), app)
  assert.deepEqual(Object.keys(servers).sort(), ['Roblox_Studio', 'blender'])
  assert.equal(servers.Roblox_Studio?.command, '/custom/StudioMCP')
  assert.deepEqual(defaultStudioMcp('win32', { LOCALAPPDATA: 'C:\\Users\\d\\AppData\\Local' })?.command, 'cmd.exe')
  assert.equal(defaultStudioMcp('darwin', {})?.command, '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP')
})

test('git status, diff, revert and commit', async () => {
  const dir = tmp('hangar-git-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir })
  g('init', '-q')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.luau'), 'print("a")\n')
  g('add', '.')
  g('commit', '-qm', 'init')

  writeFileSync(join(dir, 'a.luau'), 'print("b")\n')
  writeFileSync(join(dir, 'new.luau'), 'local x = 1\n')
  const st = await gitStatus(dir)
  assert.equal(st.isRepo, true)
  assert.deepEqual(st.files.map((f) => [f.path, f.status]).sort(), [['a.luau', ' M'], ['new.luau', '??']])

  const diff = await gitDiff(dir)
  assert.match(diff, /-print\("a"\)/)
  assert.match(diff, /\+local x = 1/, 'untracked files appear in the diff')

  assert.equal(await gitRevertFile(dir, 'a.luau'), 'restored')
  assert.equal(await gitRevertFile(dir, 'new.luau'), 'untracked')
  await assert.rejects(gitRevertFile(dir, '../outside'))

  await gitCommit(dir, 'add new file')
  assert.equal((await gitStatus(dir)).files.length, 0)
  assert.equal((await gitStatus(tmp('hangar-nogit-'))).isRepo, false)
  assert.deepEqual(parsePorcelain('R  new.txt\0old.txt\0 M b.txt\0'), [
    { path: 'new.txt', status: 'R ' },
    { path: 'b.txt', status: ' M' }
  ])
})
