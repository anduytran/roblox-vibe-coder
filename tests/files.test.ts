import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  for (const bad of ['..', '../x', '/etc', 'src/../..', 'src//server', '.git', '.GIT/hooks', 'linked-dir', 'src\\server', 'CLAUDE.md', '~', 'a\0b']) {
    assert.throws(() => listProjectDir(root, bad), /not in the project/, bad)
  }
})

test('files: only listed plain files can be read; text, binary and long files', () => {
  const { root } = project()
  assert.deepEqual(readProjectFile(root, 'CLAUDE.md'), { ...readProjectFile(root, 'CLAUDE.md'), path: 'CLAUDE.md', kind: 'text', text: '# Conventions\nUse Luau.', truncated: false })
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
  const { root } = project()
  assert.equal(projectEntryPath(root, ''), root)
  assert.equal(projectEntryPath(root, 'src/server/main.server.luau'), join(root, 'src', 'server', 'main.server.luau'))
  assert.equal(projectEntryPath(root, '.claude'), join(root, '.claude'))
  assert.equal(projectEntryPath(root, 'linked.txt'), null)
  assert.equal(projectEntryPath(root, '.git'), null)
  assert.equal(projectEntryPath(root, '../x'), null)
})
