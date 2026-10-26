import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listProjectDir, projectEntryPath, readProjectFile } from '../src/main/projectFiles'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

function project(): { root: string; outside: string } {
  const root = tmp('hangar-files-')
  const outside = tmp('hangar-files-out-')
  writeFileSync(join(outside, 'secret.txt'), 'SECRET')
  mkdirSync(join(root, 'src', 'server'), { recursive: true })
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, 'CLAUDE.md'), '# Conventions\nUse Luau.')
  writeFileSync(join(root, 'default.project.json'), '{}')
  writeFileSync(join(root, 'src', 'server', 'main.server.luau'), 'print("hi")')
  writeFileSync(join(root, '.claude', 'agents', 'lead.md'), 'You lead.')
  writeFileSync(join(root, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'))
  symlinkSync(outside, join(root, 'linked-dir'))
  return { root, outside }
}

test('files: folders first then files, links and .git left out (and counted), one folder at a time', () => {
  const { root } = project()
  const top = listProjectDir(root, '')
  assert.deepEqual(
    top.entries.map((e) => `${e.kind}:${e.name}`),
    ['dir:.claude', 'dir:src', 'file:CLAUDE.md', 'file:default.project.json', 'file:icon.png']
  )
  assert.equal(top.skipped, 3, '.git and two links')
  assert.deepEqual(
    listProjectDir(root, 'src/server').entries.map((e) => e.path),
    ['src/server/main.server.luau']
  )
  for (const bad of ['..', '../x', '/etc', 'src/../..', 'src//server', '.git', '.GIT/hooks', 'linked-dir', 'src\\server', 'CLAUDE.md', 'GIT~1', 'src.', 'src ', 'src:x', 'a\0b', 42]) {
    assert.throws(() => listProjectDir(root, bad as string), /not in the project/, String(bad))
  }
})

test('files: names Node never expands ($, %, ~) open normally; Windows look-alike names are left out', () => {
  const { root } = project()
  for (const name of ['$Types.luau', '100% done.md', '~old.txt']) writeFileSync(join(root, name), 'ok')
  writeFileSync(join(root, 'notes~1.md'), 'short-name look-alike')
  const top = listProjectDir(root, '')
  assert.ok(top.entries.some((e) => e.name === '$Types.luau'))
  assert.ok(!top.entries.some((e) => e.name === 'notes~1.md'), 'could be another file on Windows')
  assert.equal(readProjectFile(root, '100% done.md').text, 'ok')
  assert.equal(readProjectFile(root, '~old.txt').text, 'ok')
})

test('files: a project registered through a link works; a huge folder is listed in part, quickly', () => {
  const { root } = project()
  const via = join(tmp('hangar-files-via-'), 'game')
  symlinkSync(root, via)
  assert.ok(listProjectDir(via, '').entries.some((e) => e.name === 'CLAUDE.md'))
  assert.equal(readProjectFile(via, 'CLAUDE.md').kind, 'text')
  const big = join(root, 'big')
  mkdirSync(big)
  for (let i = 0; i < 25_000; i++) writeFileSync(join(big, `f${i}.txt`), '')
  const t = performance.now()
  const l = listProjectDir(root, 'big')
  assert.ok(performance.now() - t < 1500, 'bounded work')
  assert.equal(l.entries.length, 1000)
  assert.equal(l.capped, true)
  // Natural order (f2 before f10), whatever order the disk lists them in.
  const nums = l.entries.map((e) => Number(e.name.slice(1, -4)))
  assert.ok(nums.every((n, i) => i === 0 || n > nums[i - 1]!), 'natural order')
})

test('files: only listed plain files can be read; text, binary and long files', () => {
  const { root } = project()
  const claude = readProjectFile(root, 'CLAUDE.md')
  assert.equal(claude.kind, 'text')
  assert.equal(claude.text, '# Conventions\nUse Luau.')
  assert.equal(claude.truncated, false)
  assert.equal(readProjectFile(root, '.claude/agents/lead.md').text, 'You lead.')
  const png = readProjectFile(root, 'icon.png')
  assert.equal(png.kind, 'binary')
  assert.equal(png.text, null)
  for (const bad of ['linked.txt', 'linked-dir/secret.txt', '.git/config', '../outside.txt', 'src', 'nope.md', '']) {
    assert.throws(() => readProjectFile(root, bad), /not in the project/, bad)
  }
  // Over 512 KB: the start is shown, and a character cut in two at the end is left off rather than garbled.
  writeFileSync(join(root, 'big.txt'), 'a'.repeat(512 * 1024 - 1) + 'é' + 'b'.repeat(100))
  const big = readProjectFile(root, 'big.txt')
  assert.equal(big.truncated, true)
  assert.equal(big.text!.length, 512 * 1024 - 1)
  assert.ok(!big.text!.includes('�'))
  // A file swapped for a link is no longer readable.
  rmSync(join(root, 'CLAUDE.md'))
  symlinkSync(join(root, '..'), join(root, 'CLAUDE.md'))
  assert.throws(() => readProjectFile(root, 'CLAUDE.md'), /not in the project/)
})

test('files: "Show in Finder" only finds listed entries', () => {
  const { root: given } = project()
  const root = realpathSync(given)
  assert.equal(projectEntryPath(given, ''), root)
  assert.equal(projectEntryPath(given, 'src/server/main.server.luau'), join(root, 'src', 'server', 'main.server.luau'))
  assert.equal(projectEntryPath(given, '.claude'), join(root, '.claude'))
  assert.equal(projectEntryPath(root, 'linked.txt'), null)
  assert.equal(projectEntryPath(root, '.git'), null)
  assert.equal(projectEntryPath(root, '../x'), null)
})
