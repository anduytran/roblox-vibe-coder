import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffTotals, splitDiff, unquoteGitPath } from '../src/shared/diff'

// Real `git diff` output: deleted, binary, a normal edit whose content starts with "+++", a rename to a
// quoted path with an accented letter, and an untracked file shown with --no-index.
const SAMPLE = [
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 587be6b..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-x',
  'diff --git a/img.bin b/img.bin',
  'index 88768ef..f68ed80 100644',
  'Binary files a/img.bin and b/img.bin differ',
  'diff --git a/keep.txt b/keep.txt',
  'index 422c2b7..3c2787b 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,2 +1,3 @@',
  ' a',
  '-b',
  '+B',
  '++++ not a header',
  'diff --git a/old.txt "b/new name \\303\\251.txt"',
  'similarity index 100%',
  'rename from old.txt',
  'rename to "new name \\303\\251.txt"',
  'diff --git a/fresh.txt b/fresh.txt',
  'new file mode 100644',
  'index 0000000..8ba3a16',
  '--- /dev/null',
  '+++ b/fresh.txt',
  '@@ -0,0 +1 @@',
  '+n',
  '(could not diff huge.bin: too big)',
  ''
].join('\n')

test('diff: one entry per file with the right path, status and counts', () => {
  const { files, notes } = splitDiff(SAMPLE)
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added, f.removed]),
    [
      ['gone.txt', 'deleted', 0, 1],
      ['img.bin', 'modified', 0, 0],
      ['keep.txt', 'modified', 2, 1],
      ['new name é.txt', 'renamed', 0, 0],
      ['fresh.txt', 'added', 1, 0]
    ]
  )
  assert.equal(files[3]!.oldPath, 'old.txt')
  assert.deepEqual(files.map((f) => f.binary), [false, true, false, false, false])
  assert.deepEqual(notes, ['(could not diff huge.bin: too big)'])
  // "+++ not a header" inside a hunk is an added line, not a file header.
  assert.ok(files[2]!.lines.some((l) => l.kind === 'add' && l.text === '++++ not a header'))
  assert.deepEqual(diffTotals(files), { added: 3, removed: 2, lines: files.reduce((n, f) => n + f.lines.length, 0) })
  assert.equal(files[4]!.lines[files[4]!.lines.length - 1]!.text, '+n', 'no blank line from the final newline')
})

test('diff: unusual input never throws and keeps unknown text as notes', () => {
  assert.deepEqual(splitDiff(''), { files: [], notes: [] })
  assert.deepEqual(splitDiff('just some text\n'), { files: [], notes: ['just some text'] })
  const spaced = splitDiff('diff --git a/my file.txt b/my file.txt\n--- a/my file.txt\n+++ b/my file.txt\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(spaced.files[0]!.path, 'my file.txt')
  const crlf = splitDiff('diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')
  assert.deepEqual([crlf.files[0]!.added, crlf.files[0]!.removed], [1, 1])
  assert.equal(unquoteGitPath('"tab\\there \\"q\\""'), 'tab\there "q"')
  assert.equal(unquoteGitPath('plain.txt'), 'plain.txt')
  // A long diff is handled quickly (one pass).
  const big = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,100000 @@\n' + '+line\n'.repeat(100_000)
  const t = performance.now()
  assert.equal(splitDiff(big).files[0]!.added, 100_000)
  assert.ok(performance.now() - t < 1500)
})

test('review fixes: binary keeps New/Deleted; notes after header-only files; " b/" in a path; copies', () => {
  const d = [
    'diff --git a/art/logo.png b/art/logo.png',
    'deleted file mode 100644',
    'index 1234567..0000000',
    'Binary files a/art/logo.png and /dev/null differ',
    '(could not diff big.rbxl: too big)',
    'diff --git a/new.png b/new.png',
    'new file mode 100644',
    'index 0000000..1234567',
    'Binary files /dev/null and b/new.png differ',
    'diff --git a/x b/y.txt b/x b/y.txt',
    'index 1..2 100644',
    'Binary files a/x b/y.txt and b/x b/y.txt differ',
    'diff --git a/base.lua b/copy.lua',
    'similarity index 90%',
    'copy from base.lua',
    'copy to copy.lua',
    '--- a/base.lua',
    '+++ b/copy.lua',
    '@@ -1 +1 @@',
    '-a',
    '+b'
  ].join('\n')
  const { files, notes } = splitDiff(d)
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [
    ['art/logo.png', 'deleted', true],
    ['new.png', 'added', true],
    ['x b/y.txt', 'modified', true],
    ['copy.lua', 'copied', false]
  ])
  assert.equal(files[3]!.oldPath, 'base.lua')
  assert.deepEqual(notes, ['(could not diff big.rbxl: too big)'])
})

test('review fixes: hidden characters in file names are shown, never acted out', async () => {
  const { revealHidden, hasHidden } = await import('../src/shared/text')
  const { files } = splitDiff('diff --git a/evil\\342\\200\\256aul.tini "b/evil\\342\\200\\256aul.tini"\nnew file mode 100644\n--- /dev/null\n+++ "b/evil\\342\\200\\256aul.tini"\n@@ -0,0 +1 @@\n+x\n')
  assert.ok(hasHidden(files[0]!.path), 'the data keeps the real name')
  assert.equal(revealHidden(files[0]!.path), 'evil⟦U+202E⟧aul.tini', 'what the window shows')
})

test('review fixes: git diff output is pinned to a/ b/ prefixes and plain renames, whatever the config', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gitDiff } = await import('../src/main/git')
  const dir = mkdtempSync(join(tmpdir(), 'hangar-diffcfg-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q')
  g('config', 'user.email', 'a@b')
  g('config', 'user.name', 'a')
  g('config', 'diff.mnemonicPrefix', 'true')
  g('config', 'diff.renames', 'copies')
  writeFileSync(join(dir, 'base.lua'), 'local x = 1\nlocal y = 2\nlocal z = 3\nreturn x + y + z\n')
  g('add', '.')
  g('commit', '-qm', 'x')
  writeFileSync(join(dir, 'base.lua'), 'local x = 1\nlocal y = 2\nlocal z = 4\nreturn x + y + z\n')
  writeFileSync(join(dir, 'copy.lua'), 'local x = 1\nlocal y = 2\nlocal z = 3\nreturn x + y + z\n')
  g('add', 'copy.lua')
  const out = await gitDiff(dir)
  assert.match(out, /^diff --git a\/base\.lua b\/base\.lua$/m)
  assert.doesNotMatch(out, /^copy from/m, 'a new file is shown as new, not as a copy')
  const parsed = splitDiff(out).files
  assert.deepEqual(parsed.map((f) => [f.path, f.status]).sort(), [['base.lua', 'modified'], ['copy.lua', 'added']])
})

test('second pass: names keep invisible edges; keys and jump labels are unique', async () => {
  const { fileKeys, chipLabels } = await import('../src/shared/diff')
  assert.equal(unquoteGitPath('"\\357\\273\\277init.lua"'), '﻿init.lua', 'a leading BOM is kept')
  assert.equal(unquoteGitPath('init.lua　'), 'init.lua　', 'no trimming')
  const twice = splitDiff(
    'diff --git a/u.txt b/u.txt\ndeleted file mode 100644\n--- a/u.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' +
      'diff --git a/u.txt b/u.txt\nnew file mode 100644\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1 @@\n+x\n' +
      'diff --git a/u.txt b/u.txt\nnew file mode 100644\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1 @@\n+y\n'
  ).files
  const keys = fileKeys(twice)
  assert.equal(new Set(keys).size, 3, 'deleted + new + a repeat each get their own key')
  const f = (path: string) => ({ path, oldPath: null, status: 'modified' as const, binary: false, added: 0, removed: 0, lines: [] })
  assert.deepEqual(chipLabels([f('src/Combat/init.luau'), f('src/Shop/init.luau'), f('src/main.luau')]), ['Combat/init.luau', 'Shop/init.luau', 'main.luau'])
  assert.deepEqual(chipLabels([f('a/x/init.luau'), f('b/x/init.luau')]), ['a/x/init.luau', 'b/x/init.luau'])
})

test('second pass: code lines reveal only characters that disguise code', async () => {
  const { revealCodeHidden, CODE_HIDDEN_CHARS } = await import('../src/shared/text')
  assert.equal(revealCodeHidden('if x ‮ then'), 'if x ⟦U+202E⟧ then')
  assert.equal(revealCodeHidden('local s = "👨‍👩‍👧 ❤️ 日本　語"'), 'local s = "👨‍👩‍👧 ❤️ 日本　語"', 'emoji and CJK text unchanged')
  assert.ok(new RegExp(CODE_HIDDEN_CHARS.source, 'u').test('a⁦b'))
})

test('second pass: git diff is quoted, separates paths, and works before the first commit', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gitDiff } = await import('../src/main/git')
  const repo = (): { dir: string; g: (...a: string[]) => string } => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-diff2-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
    g('init', '-q')
    g('config', 'user.email', 'a@b')
    g('config', 'user.name', 'a')
    return { dir, g }
  }

  // core.quotePath=false in the repo: names still arrive escaped, so hidden characters can't act.
  const a = repo()
  a.g('config', 'core.quotePath', 'false')
  writeFileSync(join(a.dir, 'base.lua'), 'x\n')
  a.g('add', '.')
  a.g('commit', '-qm', 'x')
  writeFileSync(join(a.dir, 'evil‮aul.tini'), 'y\n')
  const outA = await gitDiff(a.dir)
  assert.ok(!outA.includes('‮'), 'no raw override character in the diff text')
  assert.equal(splitDiff(outA).files[0]!.path, 'evil‮aul.tini')

  // A file named HEAD can't change what's compared: staged edits still show.
  const b = repo()
  writeFileSync(join(b.dir, 'x.lua'), 'one\n')
  b.g('add', '.')
  b.g('commit', '-qm', 'x')
  writeFileSync(join(b.dir, 'x.lua'), 'two\n')
  b.g('add', 'x.lua')
  writeFileSync(join(b.dir, 'HEAD'), '')
  const paths = splitDiff(await gitDiff(b.dir)).files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['HEAD', 'x.lua'])

  // No commits yet: staged files are compared with the empty tree.
  const c = repo()
  writeFileSync(join(c.dir, 'first.lua'), 'hi\n')
  c.g('add', '.')
  const firstFiles = splitDiff(await gitDiff(c.dir)).files
  assert.deepEqual(firstFiles.map((f) => [f.path, f.status]), [['first.lua', 'added']])
})

test('final pass: submodule bumps always show; names are literal; omissions are noted', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gitDiff, gitStatus } = await import('../src/main/git')
  const mk = (): { dir: string; g: (...a: string[]) => string } => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-diff3-'))
    const g = (...a: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...a], { cwd: dir }).toString()
    g('init', '-q')
    g('config', 'user.email', 'a@b')
    g('config', 'user.name', 'a')
    return { dir, g }
  }

  // A submodule marked ignore = all: bumping it still shows in the diff and the file list.
  const lib = mk()
  writeFileSync(join(lib.dir, 'lib.lua'), 'v1\n')
  lib.g('add', '.')
  lib.g('commit', '-qm', 'v1')
  const game = mk()
  writeFileSync(join(game.dir, 'x.lua'), 'x\n')
  game.g('add', '.')
  game.g('commit', '-qm', 'x')
  game.g('submodule', 'add', '-q', lib.dir, 'sub')
  game.g('config', '-f', '.gitmodules', 'submodule.sub.ignore', 'all')
  game.g('add', '.')
  game.g('commit', '-qm', 'sub')
  writeFileSync(join(lib.dir, 'lib.lua'), 'v2\n')
  lib.g('commit', '-qam', 'v2')
  execFileSync('git', ['pull', '-q'], { cwd: join(game.dir, 'sub') })
  game.g('add', 'sub')
  const out = await gitDiff(game.dir)
  assert.ok(splitDiff(out).files.some((f) => f.path === 'sub'), 'the submodule bump is a file entry')
  assert.ok((await gitStatus(game.dir)).files.some((f) => f.path === 'sub'))

  // A file literally named *.lua is that file, not a pattern.
  const lit = mk()
  for (const n of ['*.lua', 'a.lua']) writeFileSync(join(lit.dir, n), '1\n')
  lit.g('add', '.')
  lit.g('commit', '-qm', 'x')
  for (const n of ['*.lua', 'a.lua']) writeFileSync(join(lit.dir, n), '2\n')
  assert.deepEqual(splitDiff(await gitDiff(lit.dir, '*.lua')).files.map((f) => f.path), ['*.lua'])

  // A nested repository and files past the first 50 are noted, not silently dropped.
  const many = mk()
  writeFileSync(join(many.dir, 'x.lua'), 'x\n')
  many.g('add', '.')
  many.g('commit', '-qm', 'x')
  mkdirSync(join(many.dir, 'nested'))
  execFileSync('git', ['init', '-q'], { cwd: join(many.dir, 'nested') })
  for (let i = 0; i < 55; i++) writeFileSync(join(many.dir, `new${String(i).padStart(2, '0')}.lua`), `${i}\n`)
  const notes = splitDiff(await gitDiff(many.dir)).notes.join('\n')
  assert.match(notes, /more new files not shown here/)
  const nestedOnly = mk()
  writeFileSync(join(nestedOnly.dir, 'x.lua'), 'x\n')
  nestedOnly.g('add', '.')
  nestedOnly.g('commit', '-qm', 'x')
  mkdirSync(join(nestedOnly.dir, 'nested'))
  execFileSync('git', ['init', '-q'], { cwd: join(nestedOnly.dir, 'nested') })
  assert.match(splitDiff(await gitDiff(nestedOnly.dir)).notes.join('\n'), /could not diff nested\/: it is a separate git repository/)
})
