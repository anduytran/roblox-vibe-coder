import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Project, Review } from '../src/shared/types'
import { currentBranch, tidyWorkingFolder } from '../src/main/git'
import { StudioSync } from '../src/main/studioSync'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

function repo() {
  const dir = tmp('hangar-nb-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src' } } }))
  writeFileSync(join(dir, 'game.luau'), 'v1')
  g('add', '.')
  g('commit', '-qm', 'init')
  return { dir, g }
}

test('no branches to manage: a folder left on a task branch goes back to main; an empty task branch is removed', async () => {
  const { dir, g } = repo()
  g('checkout', '-q', '-b', 'hangar/lead-old-abc123')
  assert.deepEqual(await tidyWorkingFolder(dir), ['The folder was left on hangar/lead-old-abc123; Hangar switched it back to main.'])
  assert.equal(await currentBranch(dir), 'main')
  assert.equal(g('branch', '--list', 'hangar/*').trim(), '')
  // One with work of its own is kept (it's a review).
  g('checkout', '-q', '-b', 'hangar/lead-work-abc123')
  writeFileSync(join(dir, 'x.luau'), 'x')
  g('add', '.')
  g('commit', '-qm', 'work')
  await tidyWorkingFolder(dir)
  assert.equal(await currentBranch(dir), 'main')
  assert.match(g('branch', '--list', 'hangar/*'), /lead-work/)
})

test('no branches to manage: edits made outside Hangar are saved as a commit instead of blocking', async () => {
  const { dir, g } = repo()
  writeFileSync(join(dir, 'game.luau'), 'edited in Studio')
  writeFileSync(join(dir, 'new.luau'), 'new')
  const notes = await tidyWorkingFolder(dir)
  assert.match(notes[0]!, /Saved 2 changes made outside Hangar/)
  assert.equal(g('status', '--porcelain').trim(), '')
  assert.equal(g('log', '-1', '--format=%s').trim(), 'Changes made outside Hangar')
  assert.equal(readFileSync(join(dir, 'game.luau'), 'utf8'), 'edited in Studio', 'nothing lost')
  // Uncommitted changes on a task branch are left for you.
  g('checkout', '-q', '-b', 'hangar/lead-dirty-abc123')
  writeFileSync(join(dir, 'game.luau'), 'half done')
  assert.deepEqual(await tidyWorkingFolder(dir), [])
  assert.equal(await currentBranch(dir), 'hangar/lead-dirty-abc123')
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  kill(): boolean {
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

test('Try it in Studio serves the change from a separate copy; the game folder stays on main', async () => {
  const { dir, g } = repo()
  g('checkout', '-q', '-b', 'hangar/lead-change-abc123')
  writeFileSync(join(dir, 'game.luau'), 'v2')
  g('commit', '-qam', 'v2')
  const head = g('rev-parse', 'HEAD').trim()
  g('checkout', '-q', 'main')
  const previews = tmp('hangar-nb-prev-')
  let cwd = ''
  const sync = new StudioSync({
    rojo: () => '/opt/rojo',
    emit: () => {},
    previewDir: (id) => join(previews, id),
    spawnFn: ((_c: string, _a: string[], o: { cwd: string }) => {
      cwd = o.cwd
      return new FakeChild()
    }) as never
  })
  const project = { id: 'p1', name: 'G', path: dir, createdAt: 1, settings: {} } as Project
  const review = { id: 'r1', title: 'Make it v2', headSha: head, projectId: 'p1' } as Review
  const st = await sync.startReview(project, review)
  assert.equal(st.reviewId, 'r1')
  assert.equal(cwd, join(previews, 'p1'))
  assert.equal(readFileSync(join(cwd, 'game.luau'), 'utf8'), 'v2', 'Studio gets the change')
  assert.equal(await currentBranch(dir), 'main', 'your folder never switched')
  assert.equal(readFileSync(join(dir, 'game.luau'), 'utf8'), 'v1')
  sync.stop()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(existsSync(join(previews, 'p1')), false, 'the copy is cleaned up')
})
