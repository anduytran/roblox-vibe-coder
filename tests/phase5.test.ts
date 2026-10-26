import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CostTracker } from '../src/main/costs'

test('spend history: one bar per local day, today last, split by agent for a game and by game for all', () => {
  const c = new CostTracker(join(mkdtempSync(join(tmpdir(), 'hangar-hist-')), 'costs.json'))
  const DAY = 24 * 3600 * 1000
  const now = new Date(2026, 9, 25, 15, 0).getTime()
  c.record('p1', 'lead', 1, now - 60_000)
  c.record('p1', 'scripter', 0.5, now - DAY)
  c.record('p2', 'main', 2, now - DAY)
  c.record('p1', 'lead', 0.25, now - 13 * DAY)
  c.record('p1', 'lead', 3, now - 20 * DAY)
  const all = c.history(14, undefined, now)
  assert.equal(all.length, 14)
  assert.equal(all[13]!.start, new Date(2026, 9, 25).getTime(), 'today is last, starting at local midnight')
  assert.equal(all[13]!.usd, 1)
  assert.equal(all[12]!.usd, 2.5)
  assert.deepEqual(all[12]!.by, { p1: 0.5, p2: 2 })
  assert.equal(all[0]!.usd, 0.25, 'thirteen days ago is the first bar')
  assert.equal(
    all.reduce((n, d) => n + d.usd, 0),
    3.75,
    'older than the window is left out'
  )
  const one = c.history(14, 'p1', now)
  assert.deepEqual(one[12]!.by, { scripter: 0.5 })
  assert.equal(one[13]!.by.lead, 1)
  assert.equal(c.history(500, undefined, now).length, 60, 'at most the 60 days kept')
  assert.equal(c.history(0, undefined, now).length, 1)
})

test('spend history: agent ids that are also names on Object (a role file called constructor.md) add up as numbers', () => {
  const c = new CostTracker(join(mkdtempSync(join(tmpdir(), 'hangar-hist2-')), 'costs.json'))
  const now = new Date(2026, 9, 25, 15, 0).getTime()
  c.record('p1', 'constructor', 0.42, now - 1000)
  c.record('p1', 'toString', 0.1, now - 500)
  const day = c.history(14, 'p1', now)[13]!
  assert.equal(day.by.constructor, 0.42)
  assert.equal(day.by.toString, 0.1)
  assert.equal(typeof day.by.constructor, 'number')
})
