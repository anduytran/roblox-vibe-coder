import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectRegistry } from '../src/main/projects'
import { resolveCommand, TestPlacePublisher, unsafeRojoPaths, validateOpenCloudKey } from '../src/main/testPlace'
import { mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { linksInCommit } from '../src/main/git'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('publishing needs a test place and a key, and only publishes to the saved IDs', async () => {
  const reg = new ProjectRegistry(join(tmp('hangar-pub-'), 'projects.json'))
  const p = reg.add(tmp('hangar-pub-proj-'))
  let key: string | null = null
  const publisher = new TestPlacePublisher({ registry: reg, keys: { get: () => key } as any, rojoCommand: () => 'rojo', workDir: tmp('hangar-pub-work-') })
  const review = { projectId: p.id, branch: 'hangar/main-x-abc123' } as any
  await assert.rejects(publisher.publish(review), /test place/)
  reg.update(p.id, { settings: { testPlace: { universeId: '123', placeId: '456' } } })
  await assert.rejects(publisher.publish(review), /Open Cloud API key/)
  key = 'k'.repeat(40)
  await assert.rejects(publisher.publish(review), /Couldn't find Rojo|Invalid review/, 'refuses before uploading anything when the branch can\'t be built')
  // IDs must be numbers
  assert.equal(reg.update(p.id, { settings: { testPlace: { universeId: '12; rm -rf', placeId: '4' } } }).settings.testPlace, null)
  assert.equal(validateOpenCloudKey('short'), 'That does not look like a Roblox Open Cloud API key.')
  assert.equal(validateOpenCloudKey('A'.repeat(64)), null)
})

test('audit: Rojo project files may not point outside the project', () => {
  const tree = tmp('hangar-rojo-')
  writeFileSync(join(tree, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ServerScriptService: { $path: 'src/server' } } }))
  assert.deepEqual(unsafeRojoPaths(tree), [])
  mkdirSync(join(tree, 'sub'))
  writeFileSync(join(tree, 'sub', 'evil.project.json'), JSON.stringify({ tree: { A: { $path: '/home/u/.ssh/id_rsa' }, B: { $path: '../secrets' }, C: { $path: { optional: '~/x' } }, D: { $path: 'C:\\Users\\x' } } }))
  const bad = unsafeRojoPaths(tree)
  assert.equal(bad.length, 4)
})

test('audit: Rojo is resolved from PATH only, never from the branch folder', () => {
  const dir = tmp('hangar-path-')
  const bin = join(dir, 'rojo')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  assert.equal(resolveCommand('rojo', { PATH: dir }, 'linux'), bin)
  assert.equal(resolveCommand('rojo', { PATH: '.' }, 'linux'), null, 'relative PATH entries are ignored')
  assert.equal(resolveCommand('./rojo', { PATH: dir }, 'linux'), null)
})

test('audit: symlinks in a branch are detected before publishing', async () => {
  const dir = tmp('hangar-link-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString().trim()
  g('init', '-q')
  g('config', 'user.email', 'a@b.c')
  g('config', 'user.name', 'a')
  writeFileSync(join(dir, 'a.txt'), 'x')
  symlinkSync('/etc/hostname', join(dir, 'leak.txt'))
  g('add', '.')
  g('commit', '-qm', 'x')
  assert.deepEqual(await linksInCommit(dir, g('rev-parse', 'HEAD')), ['leak.txt'])
})
