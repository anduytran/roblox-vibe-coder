import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitCommit, gitStatus, mergeTaskBranch, tidyWorkingFolder } from '../src/main/git'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-mc-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'game.luau'), 'print("v1")\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const branch = (name: string, text: string): string => {
    g('checkout', '-q', '-b', name, 'main')
    writeFileSync(join(dir, 'Gun.luau'), text)
    g('add', '.')
    g('commit', '-qm', name)
    const sha = g('rev-parse', 'HEAD')
    g('checkout', '-q', 'main')
    return sha
  }
  return { dir, g, branch }
}

test('merge: a change that clashes with the base is refused and the folder is left clean', async () => {
  const r = repo()
  const a = r.branch('hangar/lead-gun-a-111111', 'return "first gun"\n')
  const b = r.branch('hangar/lead-gun-b-222222', 'return "second gun"\n')
  await mergeTaskBranch(r.dir, 'main', 'hangar/lead-gun-a-111111', a, 'First gun')
  await assert.rejects(mergeTaskBranch(r.dir, 'main', 'hangar/lead-gun-b-222222', b, 'Second gun'), /clashes with work already on main \(in Gun\.luau\)\. Nothing was merged/)
  assert.deepEqual((await gitStatus(r.dir)).files, [], 'no half-finished merge left behind')
  assert.equal(readFileSync(join(r.dir, 'Gun.luau'), 'utf8'), 'return "first gun"\n')
  assert.equal(r.g('log', '--format=%s', '-1'), 'First gun')
  // Nothing for the tidy-up to save afterwards.
  assert.deepEqual(await tidyWorkingFolder(r.dir), [])
})

test('merge: the same change merged twice just finishes', async () => {
  const r = repo()
  const a = r.branch('hangar/lead-gun-a-333333', 'return "gun"\n')
  const b = r.branch('hangar/lead-gun-b-444444', 'return "gun"\n')
  await mergeTaskBranch(r.dir, 'main', 'hangar/lead-gun-a-333333', a, 'Gun')
  await mergeTaskBranch(r.dir, 'main', 'hangar/lead-gun-b-444444', b, 'Gun again')
  assert.equal(r.g('log', '--format=%s', '-1'), 'Gun')
  assert.equal(r.g('branch', '--list', 'hangar/*'), '')
})

test('a half-finished merge is never saved as a commit', async () => {
  const r = repo()
  const b = r.branch('hangar/lead-gun-b-555555', 'return "theirs"\n')
  writeFileSync(join(r.dir, 'Gun.luau'), 'return "ours"\n')
  r.g('add', '.')
  r.g('commit', '-qm', 'ours')
  try {
    r.g('merge', '--squash', b)
  } catch {
    // conflicts, as expected
  }
  await assert.rejects(tidyWorkingFolder(r.dir), /half-finished, with conflicts in Gun\.luau/)
  await assert.rejects(gitCommit(r.dir, 'save'), /half-finished/)
  assert.equal(r.g('log', '--format=%s', '-1'), 'ours')
})
