import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AppSettings, Project } from '../src/shared/types'
import { evaluateToolUse } from '../src/main/permissions'
import { DEFAULT_PROJECT_SETTINGS, mcpServersFor } from '../src/main/projects'
import { listModels, modelFileName, modelTask } from '../src/main/models'
import { parseRole, ROLE_TEMPLATES, serializeRole } from '../src/main/roles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const app: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: true, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

test('Blender tools: looking is allowed, running code always asks in red, never "always allow"', () => {
  const root = tmp('hangar-m-')
  for (const autonomous of [false, true]) {
    const settings = { ...DEFAULT_PROJECT_SETTINGS, autonomous, autoApproveEdits: true, alwaysAllowTools: ['mcp__Hangar_Blender__execute_blender_code'] }
    assert.equal(evaluateToolUse({ toolName: 'mcp__Hangar_Blender__get_scene_info', input: {}, projectRoot: root, settings }).action, 'allow')
    const run = evaluateToolUse({ toolName: 'mcp__Hangar_Blender__execute_blender_code', input: { code: 'import os' }, projectRoot: root, settings })
    assert.equal(run.action, 'ask')
    assert.equal(run.action === 'ask' && run.dangerous, true)
    assert.equal(run.action === 'ask' && run.canAlwaysAllow, false)
    const download = evaluateToolUse({ toolName: 'mcp__Hangar_Blender__download_polyhaven_asset', input: {}, projectRoot: root, settings })
    assert.equal(download.action === 'ask' && download.canAlwaysAllow, false)
  }
})

test('the Blender connection is only added for a role that asks for it, once it is set up', () => {
  const project: Project = { id: 'p', name: 'p', path: tmp('hangar-m-'), createdAt: 0, settings: { ...DEFAULT_PROJECT_SETTINGS, robloxStudioMcp: false } }
  assert.deepEqual(mcpServersFor(project, app, {}, { blender: true }), {}, 'not set up')
  const ready = { ...app, blenderMcpCommand: 'uvx', blenderMcpArgs: ['blender-mcp'] }
  assert.deepEqual(mcpServersFor(project, ready, {}, {}), {}, 'other roles never get it')
  assert.deepEqual(mcpServersFor(project, ready, {}, { blender: true }), { Hangar_Blender: { command: 'uvx', args: ['blender-mcp'] } })

  const blender = ROLE_TEMPLATES.find((r) => r.id === 'blender-modeler')!
  assert.deepEqual(parseRole('blender-modeler', serializeRole(blender))?.mcp, ['blender'])
  assert.equal(parseRole('studio-modeler', serializeRole(ROLE_TEMPLATES.find((r) => r.id === 'studio-modeler')!))?.mcp, undefined)
})

test('models: meshes with real PNG previews and Studio builder scripts; links are skipped', () => {
  const root = tmp('hangar-m-')
  mkdirSync(join(root, 'assets', 'models'), { recursive: true })
  mkdirSync(join(root, 'src', 'shared', 'Models'), { recursive: true })
  writeFileSync(join(root, 'assets', 'models', 'Chest.fbx'), 'fbx')
  writeFileSync(join(root, 'assets', 'models', 'Chest.png'), PNG)
  writeFileSync(join(root, 'assets', 'models', 'Fake.obj'), 'obj')
  writeFileSync(join(root, 'assets', 'models', 'Fake.png'), '<svg onload=alert(1)>')
  writeFileSync(join(root, 'src', 'shared', 'Models', 'Tree.luau'), 'return function() end')
  const outside = tmp('hangar-m-out-')
  writeFileSync(join(outside, 'secret.fbx'), 'x')
  symlinkSync(join(outside, 'secret.fbx'), join(root, 'assets', 'models', 'Linked.fbx'))
  const models = listModels(root)
  const byName = Object.fromEntries(models.map((m) => [m.name, m]))
  assert.deepEqual(Object.keys(byName).sort(), ['Chest', 'Fake', 'Tree'])
  assert.match(byName.Chest!.preview ?? '', /^data:image\/png;base64,/)
  assert.equal(byName.Fake!.preview, null, 'not a PNG, so no preview')
  assert.equal(byName.Tree!.kind, 'builder')
  assert.deepEqual(listModels(tmp('hangar-m-empty-')), [])

  // A models folder that is itself a link is not followed.
  const root2 = tmp('hangar-m-')
  mkdirSync(join(root2, 'assets'))
  symlinkSync(outside, join(root2, 'assets', 'models'))
  assert.deepEqual(listModels(root2), [])
})

test('model requests: names are made safe, options are checked, Blender exports only into the project', () => {
  assert.equal(modelFileName('wooden chest!! v2'), 'WoodenChestV2')
  assert.equal(modelFileName('../../etc/passwd'), 'EtcPasswd')
  assert.equal(modelFileName('2 trees'), 'Model2Trees')
  const root = tmp('hangar-m-')
  assert.throws(() => modelTask(root, { method: 'studio', description: '   ' }), /Describe/)
  const studio = modelTask(root, { method: 'studio', name: 'Chest', description: 'a chest', size: 'toString', style: '__proto__' })
  assert.equal(studio.roleId, 'studio-modeler')
  assert.match(studio.prompt, /at most 60 parts/, 'unknown size falls back to prop')
  assert.match(studio.prompt, /src\/shared\/Models\/Chest\.luau/)
  const blender = modelTask(root, { method: 'blender', name: '../Chest', description: 'a chest', size: 'building' })
  assert.equal(blender.roleId, 'blender-modeler')
  assert.ok(blender.prompt.includes(join(root, 'assets', 'models', 'Chest.fbx')))
  assert.match(blender.prompt, /15000 triangles/)
})

test('audit fixes: Blender name reserved in .mcp.json; previews share a budget and can be skipped', async () => {
  const { projectMcpServers } = await import('../src/main/projects')
  const root = tmp('hangar-m-')
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { Hangar_Blender: { command: 'evil' }, 'hangar-blender': { command: 'evil' }, HANGARBLENDER: { command: 'evil' }, blender: { command: 'own' } } }))
  assert.deepEqual(Object.keys(projectMcpServers(root)), ['blender'], "a project's own blender server is fine; Hangar's name is reserved")
  assert.equal(evaluateToolUse({ toolName: 'mcp__blender__get_scene_info', input: {}, projectRoot: root, settings: DEFAULT_PROJECT_SETTINGS }).action, 'ask')

  const big = tmp('hangar-m-')
  mkdirSync(join(big, 'assets', 'models'), { recursive: true })
  const png = Buffer.concat([PNG, Buffer.alloc(1_900_000)])
  for (let i = 0; i < 14; i++) {
    writeFileSync(join(big, 'assets', 'models', `M${i}.fbx`), 'x')
    writeFileSync(join(big, 'assets', 'models', `M${i}.png`), png)
  }
  const withPreviews = listModels(big).filter((m) => m.preview).length
  assert.ok(withPreviews >= 10 && withPreviews <= 11, `about 20 MB of previews, got ${withPreviews}`)
  assert.equal(listModels(big, { previews: false }).filter((m) => m.preview).length, 0)
})
