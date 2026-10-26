import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MODELS, isKnownModel, modelLabel, normalizeModel } from '../src/shared/models'
import { ProjectRegistry } from '../src/main/projects'
import { listRoles } from '../src/main/roles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('models: names typed by hand are read as the model they mean', () => {
  for (const [typed, id] of [
    ['claude-opus-5.5', 'claude-opus-5-5'],
    ['Claude Opus 5.5', 'claude-opus-5-5'],
    ['Opus 5.5', 'claude-opus-5-5'],
    ['opus', 'claude-opus-5-5'],
    ['claude-sonnet', 'claude-sonnet-5-5'],
    [' claude-haiku-5_5 ', 'claude-haiku-5-5'],
    ['anthropic/claude-fable-5.1', 'claude-fable-5-1'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5']
  ] as const) {
    assert.equal(normalizeModel(typed), id, typed)
  }
  assert.equal(normalizeModel(''), null)
  assert.equal(normalizeModel('inherit'), null)
  assert.equal(normalizeModel(42), null)
  assert.equal(normalizeModel('claude-future-9'), 'claude-future-9', 'an unknown name is kept as written')
  assert.equal(isKnownModel('claude-opus-5-5'), true)
  assert.equal(isKnownModel('claude-opus-5.5'), false)
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5 (most capable, costs more)')
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length)
})

test('models: a project or role saved with a hand-typed name runs with the right model', () => {
  const file = join(tmp('hangar-models-'), 'projects.json')
  const dir = tmp('hangar-models-proj-')
  writeFileSync(file, JSON.stringify({ projects: [{ id: 'p1', name: 'Stormbreak', path: dir, createdAt: 1, settings: { model: 'claude-opus-5.5' } }] }))
  assert.equal(new ProjectRegistry(file).get('p1').settings.model, 'claude-opus-5-5')
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'agents', 'lead.md'), '---\nname: Lead\nmodel: Opus 5.5\n---\nYou lead.')
  writeFileSync(join(dir, '.claude', 'agents', 'qa.md'), '---\nname: QA\nmodel: inherit\n---\nYou test.')
  const roles = listRoles(dir)
  assert.equal(roles.find((r) => r.id === 'lead')?.model, 'claude-opus-5-5')
  assert.equal(roles.find((r) => r.id === 'qa')?.model, undefined)
})
