import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isProtectedPath } from '../src/main/pathScope'
import { evaluateToolUse } from '../src/main/permissions'
import { DEFAULT_PROJECT_SETTINGS } from '../src/main/projects'
import { installTemplates, listRoles, parseRole, saveRole, serializeRole } from '../src/main/roles'
import { createVault, validVaultFolder, vaultInstructions, vaultStatus } from '../src/main/vault'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('vault: created from templates, never overwriting your notes', () => {
  const dir = tmp('hangar-vault-')
  assert.equal(vaultStatus(dir, 'ui-vault').exists, false)
  const created = createVault(dir, 'ui-vault')
  assert.ok(created.includes('ui-vault/Home.md') && created.includes('ui-vault/Style Guide.md') && created.includes('ui-vault/Screens/_Template.md'))
  assert.match(readFileSync(join(dir, 'ui-vault', 'Home.md'), 'utf8'), /\[\[Style Guide\]\]/)
  assert.equal(existsSync(join(dir, 'ui-vault', '.obsidian')), false, 'Hangar never creates Obsidian settings')
  writeFileSync(join(dir, 'ui-vault', 'Style Guide.md'), 'MY GUIDE')
  assert.deepEqual(createVault(dir, 'ui-vault'), [])
  assert.equal(readFileSync(join(dir, 'ui-vault', 'Style Guide.md'), 'utf8'), 'MY GUIDE')
  assert.equal(vaultStatus(dir, 'ui-vault').notes, 8)
})

test('vault: folder names must stay inside the project', () => {
  for (const ok of ['ui-vault', 'docs/ui', 'UI Notes']) assert.equal(validVaultFolder(ok), true, ok)
  for (const bad of ['../x', '/abs', '.obsidian', 'a/.hidden', '', 'a\\b', '~/notes', 'x'.repeat(60)]) assert.equal(validVaultFolder(bad), false, bad)
  assert.throws(() => createVault(tmp('v-'), '../escape'))
})

test('vault: the UI Builder template has a vault; roles round-trip the setting', () => {
  const dir = tmp('hangar-vault-roles-')
  installTemplates(dir)
  assert.equal(listRoles(dir).find((r) => r.id === 'ui-builder')?.vault, 'ui-vault')
  assert.equal(listRoles(dir).find((r) => r.id === 'scripter')?.vault, undefined)
  const role = parseRole('x', serializeRole({ id: 'x', name: 'X', description: 'd', prompt: 'p', vault: 'docs/x' }))
  assert.equal(role?.vault, 'docs/x')
  assert.equal(parseRole('y', '---\nname: Y\nvault: ../evil\n---\np')?.vault, undefined, 'invalid vault in a repo file is ignored')
  assert.throws(() => saveRole(dir, { id: 'z', name: 'Z', description: '', prompt: 'p', vault: '../evil' }), /simple folder name/)
  assert.match(vaultInstructions('ui-vault'), /Never create or edit anything in a \.obsidian folder/)
})

test('vault: agents can never write Obsidian settings (plugins there run code)', () => {
  const dir = tmp('hangar-vault-pol-')
  const s = { ...DEFAULT_PROJECT_SETTINGS, autonomous: true }
  assert.equal(isProtectedPath('ui-vault/.obsidian/plugins/x/main.js'), true)
  assert.equal(evaluateToolUse({ toolName: 'Write', input: { file_path: 'ui-vault/.obsidian/community-plugins.json' }, projectRoot: dir, settings: s }).action, 'ask')
  assert.equal(evaluateToolUse({ toolName: 'Write', input: { file_path: 'ui-vault/Screens/HUD.md' }, projectRoot: dir, settings: s }).action, 'allow', 'notes are normal files')
})
