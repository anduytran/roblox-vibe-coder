import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectRegistry } from '../src/main/projects'
import { CHECKLIST, PRODUCTS, SHIP_CHECKLIST, shipStatus, writeShipKit } from '../src/main/ship'
import { commitFiles } from '../src/main/git'
import { TestPlacePublisher } from '../src/main/testPlace'
import { createGameProject } from '../src/main/scaffold'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

function repo() {
  const dir = tmp('hangar-ship-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ServerScriptService: { $path: 'src/server' } } }))
  writeFileSync(join(dir, 'README.md'), 'hi\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  return { dir, g }
}

test('ship kit: added to an existing game in one commit, never overwriting, never through a link', async () => {
  const r = repo()
  writeFileSync(join(r.dir, 'notes.txt'), 'mine, uncommitted\n')
  const written = writeShipKit(r.dir)
  assert.deepEqual(written.sort(), [CHECKLIST, PRODUCTS, 'src/client/Shop.luau', 'src/server/Monetization.luau'].sort())
  await commitFiles(r.dir, written, 'Add the ship checklist and purchase templates')
  assert.equal(r.g('log', '--format=%s', '-1'), 'Add the ship checklist and purchase templates')
  assert.match(r.g('status', '--porcelain'), /\?\? notes\.txt/, 'your own uncommitted work is left alone')
  writeFileSync(join(r.dir, CHECKLIST), '# my own\n')
  assert.deepEqual(writeShipKit(r.dir), [], 'existing files are kept')
  assert.equal(readFileSync(join(r.dir, CHECKLIST), 'utf8'), '# my own\n')

  const other = repo()
  const outside = tmp('hangar-ship-out-')
  symlinkSync(outside, join(other.dir, 'design-vault'))
  assert.throws(() => writeShipKit(other.dir), /goes through a link/)
  assert.equal(existsSync(join(outside, 'Ship Checklist.md')), false)
})

test('ship status: checklist progress, what needs you, and purchases with real IDs', () => {
  const r = repo()
  writeShipKit(r.dir)
  let s = shipStatus(r.dir)
  assert.equal(s.hasChecklist, true)
  assert.equal(s.hasPurchaseCode, true)
  assert.ok(s.items.length >= 10)
  assert.equal(s.items.filter((i) => i.done).length, 0)
  assert.ok(s.items.some((i) => i.you && /Creator Hub/.test(i.text)))
  assert.deepEqual(s.purchases, { listed: 0, created: 0 }, 'the commented examples don\'t count')
  writeFileSync(join(r.dir, CHECKLIST), SHIP_CHECKLIST.replace('- [ ] A goal players can see', '- [x] A goal players can see'))
  writeFileSync(
    join(r.dir, PRODUCTS),
    readFileSync(join(r.dir, PRODUCTS), 'utf8').replace('Passes = {} :: { [string]: Item },', 'Passes = {\n\t\tVIP = { id = 98765, name = "VIP", price = 199, description = "x" },\n\t\tTrail = { id = 0, name = "Trail", price = 99, description = "y" },\n\t} :: { [string]: Item },')
  )
  s = shipStatus(r.dir)
  assert.equal(s.items.filter((i) => i.done).length, 1)
  assert.deepEqual(s.purchases, { listed: 2, created: 1 })
  assert.equal(shipStatus(tmp('hangar-empty-')).hasChecklist, false)
})

test('new games come with the ship checklist, purchase templates, and Monetization required', async () => {
  const parent = tmp('hangar-ship-new-')
  const root = await createGameProject({ name: 'Sky Courier', parentDir: parent, idea: 'Deliver parcels.', document: null, platforms: ['pc'], genre: '', notes: '', model: null, dailyBudgetUsd: null, studioTools: true, autopilot: { sprintTasks: 3, sprintBudgetUsd: 10, autoMerge: true }, startNow: false })
  const s = shipStatus(root)
  assert.equal(s.hasChecklist, true)
  assert.equal(s.hasPurchaseCode, true)
  assert.match(readFileSync(join(root, 'src/server/main.server.luau'), 'utf8'), /require\(script\.Parent\.Monetization\)/)
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /Ship Checklist\.md/)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(), '', 'all in the first commit')
})

test('publish to live: needs the live place and a key, refuses task branches, uploads the merged commit only', async () => {
  const r = repo()
  const reg = new ProjectRegistry(join(tmp('hangar-live-reg-'), 'projects.json'))
  const p = reg.add(r.dir)
  let key: string | null = null
  const uploads: { universeId: string; placeId: string; size: number }[] = []
  const rojo = join(tmp('hangar-live-bin-'), 'rojo')
  writeFileSync(rojo, '#!/bin/sh\n# fake rojo: build <tree> -o <out>\necho place > "$4"\n')
  chmodSync(rojo, 0o755)
  const publisher = new TestPlacePublisher({
    registry: reg,
    keys: { get: () => key },
    rojoCommand: () => rojo,
    workDir: tmp('hangar-live-work-'),
    upload: async (o) => (uploads.push({ universeId: o.universeId, placeId: o.placeId, size: o.body.length }), { versionNumber: 7 })
  })
  await assert.rejects(publisher.publishLive(p.id), /live game/)
  reg.update(p.id, { settings: { livePlace: { universeId: '111', placeId: '222' } } })
  assert.equal(reg.update(p.id, { settings: { livePlace: { universeId: '1; rm', placeId: '2' } } }).settings.livePlace, null, 'IDs must be numbers')
  reg.update(p.id, { settings: { livePlace: { universeId: '111', placeId: '222' } } })
  await assert.rejects(publisher.publishLive(p.id), /Open Cloud API key/)
  key = 'k'.repeat(40)
  writeFileSync(join(r.dir, 'draft.txt'), 'not committed\n')
  const done = await publisher.publishLive(p.id)
  assert.equal(done.versionNumber, 7)
  assert.equal(done.sha, r.g('rev-parse', 'HEAD'))
  assert.deepEqual(uploads.map((u) => [u.universeId, u.placeId]), [['111', '222']])
  r.g('checkout', '-q', '-b', 'hangar/lead-x-abc123')
  await assert.rejects(publisher.publishLive(p.id), /task branch/)
  assert.equal(uploads.length, 1)
})
