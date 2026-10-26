import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import type { Project, Review } from '../src/shared/types'
import { runChecks } from '../src/main/checks'
import { autoMergeBlocker } from '../src/main/autopilot'
import { DEFAULT_PROJECT_SETTINGS, ProjectRegistry } from '../src/main/projects'
import { ROLE_TEMPLATES } from '../src/main/roles'
import {
  CLOUD_CHECK_NAME,
  CLOUD_SCRIPT,
  cleanLuauTests,
  hasChecks,
  LUNE_CHECK_NAME,
  LUNE_RUNNER,
  LUNE_RUNNER_FILE,
  readCloudReport,
  runOnTestPlace,
  type CloudApi,
  type CloudTask
} from '../src/main/luauTests'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const script = (file: string, body: string): void => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** A git game with one spec file, and a hand-made review of its head commit. */
function game(settings: Partial<Project['settings']> = {}) {
  const dir = tmp('hangar-lt-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString().trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'Combat.luau'), 'return { damage = function(a, b) return math.max(0, a - b) end }\n')
  writeFileSync(join(dir, 'src', 'Combat.spec.luau'), 'return { ["no negative damage"] = function() end }\n')
  writeFileSync(join(dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src' } } }))
  g('add', '.')
  g('commit', '-qm', 'init')
  const project: Project = { id: '00000000-0000-4000-8000-000000000001', name: 'g', path: dir, createdAt: 0, settings: { ...DEFAULT_PROJECT_SETTINGS, sandbox: false, ...settings } }
  const review = { id: 'r1', projectId: project.id, kind: 'task', status: 'pending', files: ['src/Combat.luau'], headSha: g('rev-parse', 'HEAD'), base: 'main' } as unknown as Review
  return { dir, project, review, workDir: tmp('hangar-lt-work-'), appDataDir: tmp('hangar-lt-data-') }
}

/** A fake Open Cloud that records calls and answers the task with `final` after one poll. */
function fakeCloud(final: Partial<CloudTask>, logs: string[] = []) {
  const calls: string[] = []
  let polls = 0
  const path = 'universes/1/places/2/versions/7/luau-execution-sessions/s1/tasks/t1'
  const api: CloudApi = {
    upload: async (body) => {
      calls.push(`upload ${body.toString()}`)
      return { versionNumber: 7 }
    },
    createTask: async (version, src) => {
      calls.push(`create ${version} ${src === CLOUD_SCRIPT ? 'hangar-script' : 'other-script'}`)
      return { path, state: 'QUEUED' }
    },
    getTask: async (p) => {
      calls.push(`get ${p}`)
      return polls++ < 1 ? { path, state: 'PROCESSING' } : { path, state: 'COMPLETE', ...final }
    },
    logs: async () => logs
  }
  return { api, calls }
}

const report = (r: unknown) => [JSON.stringify(r)]

test('Luau tests: settings are cleaned, off by default, and count as checks for the pipeline', () => {
  assert.deepEqual(cleanLuauTests(undefined), { lune: false, testPlace: false })
  assert.deepEqual(cleanLuauTests({ lune: 'yes', testPlace: true }), { lune: false, testPlace: true })
  assert.equal(hasChecks(DEFAULT_PROJECT_SETTINGS), false)
  assert.equal(hasChecks({ ...DEFAULT_PROJECT_SETTINGS, luauTests: { lune: true, testPlace: false } }), true)
  const registry = new ProjectRegistry(join(tmp('hangar-lt-reg-'), 'projects.json'))
  const p = registry.add(tmp('hangar-lt-proj-'))
  assert.deepEqual(registry.get(p.id).settings.luauTests, { lune: false, testPlace: false })
  const updated = registry.update(p.id, { settings: { luauTests: { lune: true, testPlace: 1 as unknown as boolean } } })
  assert.deepEqual(updated.settings.luauTests, { lune: true, testPlace: false })
})

test('Luau tests: the runners and the QA Tester agree on the spec format', () => {
  assert.match(LUNE_RUNNER, /%\.spec%\.luau\$/)
  assert.match(LUNE_RUNNER, /cloud%\.spec%\.luau/, 'engine-only specs are left to the test place')
  assert.match(LUNE_RUNNER, /process\.exit\(1\)/, 'no tests at all is not a pass')
  assert.match(CLOUD_SCRIPT, /%\.spec\$/)
  assert.match(CLOUD_SCRIPT, /JSONEncode/)
  const qa = ROLE_TEMPLATES.find((r) => r.id === 'qa-tester')!
  assert.ok(qa.tools?.includes('Write') && qa.tools.includes('Edit'), 'QA can write tests')
  assert.ok(!qa.tools?.includes('Bash'), 'but never runs commands')
  assert.match(qa.prompt, /\.spec\.luau/)
  assert.match(qa.prompt, /\.cloud\.spec\.luau/)
})

test('Luau tests: the test place report is read as untrusted data', () => {
  const ok = readCloudReport(report({ modules: 3, loadErrors: {}, tests: [{ name: 'RS.Combat.spec > hits', ok: true }] }))
  assert.equal(ok.status, 'passed')
  assert.match(ok.output, /3 of 3 modules loaded\. 1 passed, 0 failed/)

  const bad = readCloudReport(report({ modules: 2, loadErrors: [{ name: 'RS.Shop', error: 'attempt to index nil' }], tests: [{ name: 'RS.Shop.spec > buy', ok: false, error: 'boom‮gnp.exe' }] }))
  assert.equal(bad.status, 'failed')
  assert.match(bad.output, /LOAD FAIL RS\.Shop/)
  assert.match(bad.output, /FAIL RS\.Shop\.spec > buy/)
  assert.match(bad.output, /⟦U\+202E⟧/, 'hidden characters are made visible')
  assert.doesNotMatch(bad.output, /‮/)

  assert.equal(readCloudReport(['not json']).status, 'error')
  assert.equal(readCloudReport(undefined).status, 'error')
  assert.equal(readCloudReport([42]).status, 'error')
  // A test that only says it passed with something other than true doesn't pass.
  assert.equal(readCloudReport(report({ modules: 0, tests: [{ name: 'x', ok: 'true' }] })).status, 'failed')
})

test('Luau tests: the test place run uploads, runs Hangar\'s own script, polls and reads the result', async () => {
  const pass = fakeCloud({ output: { results: report({ modules: 1, loadErrors: [], tests: [{ name: 'a', ok: true }] }) } })
  const r = await runOnTestPlace(pass.api, Buffer.from('PLACE'), { pollMs: 1 })
  assert.equal(r.status, 'passed')
  assert.match(r.output, /Test place version 7/)
  assert.deepEqual(pass.calls.slice(0, 2), ['upload PLACE', 'create 7 hangar-script'])
  assert.equal(pass.calls.filter((c) => c.startsWith('get ')).length, 2)

  const failed = fakeCloud({ state: 'FAILED', error: { message: 'Script timed out' } } as Partial<CloudTask>, ['Server: ServerScriptService.Main:12: attempt to call nil'])
  const f = await runOnTestPlace(failed.api, Buffer.from('P'), { pollMs: 1 })
  assert.equal(f.status, 'failed')
  assert.match(f.output, /Script timed out/)
  assert.match(f.output, /Main:12/, 'the end of the logs is shown')

  const stuck: CloudApi = { ...pass.api, getTask: async (p) => ({ path: p, state: 'PROCESSING' }) }
  const s = await runOnTestPlace(stuck, Buffer.from('P'), { pollMs: 1, maxWaitMs: 20 })
  assert.equal(s.status, 'error')
  assert.match(s.output, /hadn't finished/)
})

test('Luau tests: test place check builds the branch with Rojo, keeps the key in Hangar, and feeds auto-merge', async () => {
  const t = game({ testPlace: { universeId: '1', placeId: '2' }, luauTests: { lune: false, testPlace: true } })
  const bin = tmp('hangar-lt-bin-')
  // Fake Rojo: "build <tree>/ -o <out>" writes a place file that names the tree it built.
  script(join(bin, 'rojo'), 'test "$1" = build || exit 9\nls -R "$2" > "$4"')
  const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  const seen: { key: string; place: string }[] = []
  const cloud = (pass: boolean) => (place: { universeId: string; placeId: string }, apiKey: string) => {
    seen.push({ key: apiKey, place: `${place.universeId}/${place.placeId}` })
    const fake = fakeCloud({ output: { results: report({ modules: 1, loadErrors: [], tests: [{ name: 'Combat.spec > no negative damage', ok: pass }] }) } })
    const upload = fake.api.upload
    fake.api.upload = async (body) => {
      assert.match(body.toString(), /Combat\.spec\.luau/, 'the uploaded place was built from the branch')
      return upload(body)
    }
    return fake.api
  }
  const keys = { get: (id: string) => (id === t.project.id ? 'roblox-open-cloud-key-123456' : null) }
  const opts = { workDir: t.workDir, appDataDir: t.appDataDir, env, keys, rojoCommand: 'rojo', pollMs: 1, platform: 'linux' as const }

  const good = await runChecks(t.project, t.review, { ...opts, cloud: cloud(true) })
  const res = good!.results.find((r) => r.name === CLOUD_CHECK_NAME)!
  assert.equal(res.status, 'passed', res.output)
  assert.deepEqual(seen[0], { key: 'roblox-open-cloud-key-123456', place: '1/2' })
  assert.equal(autoMergeBlocker({ ...t.review, checks: good } as Review), null, 'passing Luau tests let autopilot merge')

  const bad = await runChecks(t.project, t.review, { ...opts, cloud: cloud(false) })
  assert.equal(bad!.results[0]!.status, 'failed')
  assert.match(autoMergeBlocker({ ...t.review, checks: bad } as Review) ?? '', /Checks failed: Luau tests \(test place\)/)

  const noKey = await runChecks(t.project, t.review, { ...opts, keys: { get: () => null }, cloud: cloud(true) })
  assert.equal(noKey!.results[0]!.status, 'error')
  assert.match(noKey!.results[0]!.output, /API key/)

  const noPlace = await runChecks({ ...t.project, settings: { ...t.project.settings, testPlace: null } }, t.review, { ...opts, cloud: cloud(true) })
  assert.match(noPlace!.results[0]!.output, /test place/)

  script(join(bin, 'rojo'), 'echo "error: bad project" >&2\nexit 1')
  const broken = await runChecks(t.project, t.review, { ...opts, cloud: cloud(true) })
  assert.equal(broken!.results[0]!.status, 'failed')
  assert.match(broken!.results[0]!.output, /bad project/)
  assert.equal(seen.length, 2, 'nothing is uploaded without a key, a place or a build')
})

test('Luau tests: a branch whose Rojo project points outside the project is never uploaded', async () => {
  const t = game({ testPlace: { universeId: '1', placeId: '2' }, luauTests: { lune: false, testPlace: true } })
  writeFileSync(join(t.dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $path: '../../secrets' } }))
  execFileSync('git', ['commit', '-qam', 'evil'], { cwd: t.dir })
  const review = { ...t.review, files: ['src/Combat.luau'], headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.dir }).toString().trim() } as Review
  let uploaded = false
  const r = await runChecks(t.project, review, {
    workDir: t.workDir,
    appDataDir: t.appDataDir,
    platform: 'linux',
    keys: { get: () => 'roblox-open-cloud-key-123456' },
    cloud: () => {
      uploaded = true
      throw new Error('should not be called')
    }
  })
  assert.equal(r!.results[0]!.status, 'error')
  assert.match(r!.results[0]!.output, /outside the project/)
  assert.equal(uploaded, false)
})

test('Luau tests: Lune never runs without the OS sandbox', async () => {
  const t = game({ luauTests: { lune: true, testPlace: false } })
  const off = await runChecks(t.project, t.review, { workDir: t.workDir, appDataDir: t.appDataDir, platform: 'darwin' })
  assert.equal(off!.results[0]!.name, LUNE_CHECK_NAME)
  assert.equal(off!.results[0]!.status, 'error')
  assert.match(off!.results[0]!.output, /sandbox on/)
  const win = await runChecks({ ...t.project, settings: { ...t.project.settings, sandbox: true } }, t.review, { workDir: t.workDir, appDataDir: t.appDataDir, platform: 'win32' })
  assert.match(win!.results[0]!.output, /Windows/)
})

test('Luau tests: Lune runs Hangar\'s runner in the sandboxed checkout (macOS)', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async () => {
  const t = game({ sandbox: true, luauTests: { lune: true, testPlace: false } })
  const bin = tmp('hangar-lt-bin-')
  const probe = join(homedir(), `hangar-lune-probe-${process.pid}`)
  // Fake Lune: checks it was given Hangar's runner next to the branch's specs, and tries to write outside.
  script(
    join(bin, 'lune'),
    [
      `test "$1 $2" = "run ${LUNE_RUNNER_FILE}" || exit 9`,
      `grep -q "Hangar's test runner" ${LUNE_RUNNER_FILE} || exit 8`,
      'test -f src/Combat.spec.luau || exit 7',
      `touch "${probe}" 2>/dev/null && echo "WROTE OUTSIDE"`,
      'echo "PASS src/Combat.spec.luau > no negative damage"',
      'test -f src/fail.flag && exit 1',
      'exit 0'
    ].join('\n')
  )
  const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  try {
    const r = await runChecks(t.project, t.review, { workDir: t.workDir, appDataDir: t.appDataDir, env, platform: 'darwin' })
    const res = r!.results[0]!
    assert.equal(res.status, 'passed', res.output)
    assert.match(res.output, /PASS src\/Combat\.spec\.luau/)
    assert.doesNotMatch(res.output, /WROTE OUTSIDE/)
    assert.equal(existsSync(probe), false, 'the sandbox kept the tests inside the checkout')
    assert.equal(r!.sandboxed, true)
    assert.equal(existsSync(join(t.dir, LUNE_RUNNER_FILE)), false, 'the runner only goes into the temporary checkout')

    writeFileSync(join(t.dir, 'src', 'fail.flag'), '')
    execFileSync('git', ['add', '.'], { cwd: t.dir })
    execFileSync('git', ['commit', '-qm', 'fail'], { cwd: t.dir })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.dir }).toString().trim()
    const failed = await runChecks(t.project, { ...t.review, headSha: head } as Review, { workDir: t.workDir, appDataDir: t.appDataDir, env, platform: 'darwin' })
    assert.equal(failed!.results[0]!.status, 'failed')
  } finally {
    rmSync(probe, { force: true })
  }
})
