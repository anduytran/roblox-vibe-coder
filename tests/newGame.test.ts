import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUGGESTED_CHECKS } from '../src/main/checks'
import { checksFor, NEW_GAME_CHECKS, suggestGameName } from '../src/shared/newGame'

test('new game: a name is taken from a title at the start of the idea', () => {
  assert.equal(suggestGameName('Sky Courier: glide between floating islands delivering parcels.'), 'Sky Courier')
  assert.equal(suggestGameName('## **Pizza Rush** - deliver pizzas before they go cold'), 'Pizza Rush')
  assert.equal(suggestGameName('Sky Courier\nGlide between islands.'), 'Sky Courier', 'short first line, then the pitch')
  assert.equal(suggestGameName('Sky Courier'), '', 'still typing the first line: no guess yet')
  assert.equal(suggestGameName('Players are couriers gliding between floating islands, delivering parcels before storms roll in.'), '')
  // The prefill from a trending game names someone else's game: never use that as ours.
  assert.equal(suggestGameName('An original simulator game for Roblox, in the space where “Pet Sim” is doing well (5,000 playing).\n\nWhat it\'s about: '), '')
  assert.equal(suggestGameName(''), '')
})

test('new game: an attached document gives its heading, or a non-generic file name', () => {
  const doc = (name: string, text: string) => ({ name, text })
  assert.equal(suggestGameName('', doc('design.md', '# Sky Courier — Game Design Document\nIslands drift.')), 'Sky Courier')
  assert.equal(suggestGameName('', doc('design.md', '# GDD: Sky Courier\nIslands drift.')), 'Sky Courier')
  assert.equal(suggestGameName('', doc('sky-courier_gdd.md', 'No heading here.')), 'Sky Courier')
  assert.equal(suggestGameName('', doc('design.md', '# Design\nIslands drift.')), '', 'generic heading and file name')
  assert.equal(suggestGameName('Pizza Rush: deliver pizzas.', doc('design.md', '# Sky Courier')), 'Pizza Rush', 'the idea wins')
})

test('new game: suggested names have no hidden characters', () => {
  const name = suggestGameName('Tower‮Defense​: hold the line')
  assert.equal(name, 'TowerDefense')
  assert.doesNotMatch(suggestGameName('', { name: 'x.md', text: '# Sky⁦ Courier\u{E0041}' }), /[⁦\u{E0041}]/u)
})

test('new game: the wizard lists the same checks the main process sets up, each kept only when its tool is installed', () => {
  assert.deepEqual(
    NEW_GAME_CHECKS.map((c) => c.name),
    SUGGESTED_CHECKS.map((c) => c.name)
  )
  for (const c of NEW_GAME_CHECKS) assert.ok(SUGGESTED_CHECKS.find((s) => s.name === c.name)!.command.startsWith(`${c.tool} `), c.name)
  assert.deepEqual(checksFor({ rojo: true, selene: false, stylua: true }), { on: ['Format', 'Build'], missing: ['selene'] })
  assert.deepEqual(checksFor({ rojo: false, selene: false, stylua: false }).on, [])
})
