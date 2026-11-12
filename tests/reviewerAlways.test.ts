import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AiReview, Review } from '../src/shared/types'
import { autoMergeBlocker } from '../src/main/autopilot'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewPipeline } from '../src/main/reviewPipeline'
import { ReviewStore } from '../src/main/reviews'
import { mergeWarnings } from '../src/shared/reviewRules'
import { APPROVED } from './approvingReviewer'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

function setup() {
  const registry = new ProjectRegistry(join(tmp('hangar-ra-reg-'), 'projects.json'))
  const project = registry.add(tmp('hangar-ra-game-'))
  const reviews = new ReviewStore(join(tmp('hangar-ra-rv-'), 'reviews.json'))
  const read: string[] = []
  const pipeline = new ReviewPipeline({
    registry,
    reviews,
    emit: () => {},
    runChecks: async () => null,
    reviewer: {
      review: async (_p, r): Promise<AiReview> => {
        read.push(r.id)
        return APPROVED
      }
    }
  })
  const add = (): Review =>
    reviews.add({ projectId: project.id, agentId: 'main', title: 'Gun', branch: 'hangar/main-gun-abc123', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: '', files: ['Gun.luau'], incomplete: null, note: null, clip: null })
  return { registry, project, reviews, pipeline, read, add }
}

test('reviewer always: it can no longer be switched off, and every change is read by it', async () => {
  const t = setup()
  // A setting saved as "off" by an older version reads back as on.
  t.registry.update(t.project.id, { settings: { reviewer: false } })
  assert.equal(t.registry.get(t.project.id).settings.reviewer, true)
  const r = t.add()
  await t.pipeline.start(r)
  assert.deepEqual(t.read, [r.id])
  assert.equal(t.reviews.get(r.id).aiReview?.verdict, 'approve')
})

test('reviewer always: re-running only the checks still asks the reviewer when it never finished', async () => {
  const t = setup()
  const r = t.reviews.update(t.add().id, { aiReview: { status: 'error', verdict: null, summary: '', findings: [], costUsd: 0, error: 'network' } })
  await t.pipeline.start(r, { reviewer: false })
  assert.equal(t.read.length, 1, 'no finished review: the reviewer runs')
  await t.pipeline.start(t.reviews.get(r.id), { reviewer: false })
  assert.equal(t.read.length, 1, 'already reviewed: only the checks run again')
})

test('reviewer always: nothing merges by itself without it, and Merge asks', () => {
  const t = setup()
  const passed = { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed' as const, output: '', ms: 1 }] }
  const r = t.reviews.update(t.add().id, { checks: passed })
  assert.match(autoMergeBlocker(r) ?? '', /No reviewer agent/)
  assert.match(mergeWarnings(r).join(' '), /No reviewer agent has looked at it/)
  const reviewed = t.reviews.update(r.id, { aiReview: APPROVED })
  assert.equal(autoMergeBlocker(reviewed), null)
  assert.deepEqual(mergeWarnings(reviewed), [])
})
