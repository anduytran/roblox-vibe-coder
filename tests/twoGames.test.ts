import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Project, Review } from '../src/shared/types'
import { alreadyFailing, feedbackText, NO_FILLER, SHIP_FIRST } from '../src/main/autopilot'
import { runChecks } from '../src/main/checks'
import { ALREADY_FAILING, compareLuneRuns, LUNE_CHECK_NAME } from '../src/main/luauTests'
import { DEFAULT_PROJECT_SETTINGS } from '../src/main/projects'
import { CHECKLIST, shipStatus } from '../src/main/ship'

// Lessons from two games: Stormbreak (tests nobody could run, then failures that would hold up every change) and
// Hush Halls (a Lead that planned nothing for six sprints once only the owner's tasks were left).

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

test('Lune check: failures already on the starting commit pass the change and are listed; new ones fail it', () => {
  const base = 'FAIL a.spec > old\n    boom\n1 passed, 1 failed'
  const same = compareLuneRuns('FAIL a.spec > old\n    boom\n2 passed, 1 failed', base, 1)
  assert.equal(same.status, 'passed')
  assert.match(same.output, new RegExp(`${ALREADY_FAILING.replace(/[()]/g, '\\$&')}\\n- a\\.spec > old`))
  const broke = compareLuneRuns('FAIL a.spec > old\nFAIL b.spec > new\n1 passed, 2 failed', base, 1)
  assert.equal(broke.status, 'failed')
  assert.match(broke.output, /Broken by this change:\n- b\.spec > new/)
  assert.equal(compareLuneRuns('FAIL a.spec > old', 'all passed', 0).status, 'failed', 'the start passed: every failure is new')
  assert.equal(compareLuneRuns('No *.spec.luau files found.', 'No *.spec.luau files found.', 1).status, 'passed', 'a new game with no tests yet')
  assert.equal(compareLuneRuns('runner crashed', base, 1).status, 'failed', 'a run that names no test is only excused when the start named none either')
})

test('autopilot: failing tests from main become one fix piece for the Lead, kept apart from your feedback', () => {
  const output = `x\n${ALREADY_FAILING}\n- src/shared/Hero.spec.luau > picks first\n- src/shared/Minimap.spec.luau > bounds‮\nThis change didn't break any test.`
  const review = { checks: { status: 'done', reason: null, results: [{ name: LUNE_CHECK_NAME, command: 'lune', status: 'passed', output, ms: 1 }] } } as unknown as Review
  const names = alreadyFailing(review)
  assert.deepEqual(names, ['src/shared/Hero.spec.luau > picks first', 'src/shared/Minimap.spec.luau > bounds'], 'cleaned of hidden characters')
  assert.deepEqual(alreadyFailing({ checks: null } as unknown as Review), [])
  const text = feedbackText(['Make the water slower', `Luau tests failing on the main branch: ${names.join('; ')}`], 'Owner')
  assert.match(text, /Owner:\n- Make the water slower\n/)
  assert.doesNotMatch(text.split('Owner:')[1]!.split('\n\n')[0]!, /Hero\.spec/, 'not shown as the owner\'s feedback')
  assert.match(text, /"Fix failing tests:"/)
})

test('planning: when only your tasks are left, the Lead starts the next milestone instead of stopping', () => {
  assert.match(NO_FILLER, /start the next milestone without asking/)
  assert.match(NO_FILLER, /Brief\.md/)
  assert.match(NO_FILLER, /say so and stop\.$/, 'the planner\'s "Nothing to build" wording still replaces this ending')
  assert.match(SHIP_FIRST, /heading marked "\(you\)"/)
  assert.match(SHIP_FIRST, /go on to the next milestone/)
})

test('ship status: every item under a heading marked (you) needs you', () => {
  const root = tmp('hangar-ship-you-')
  mkdirSync(join(root, 'design-vault'))
  writeFileSync(join(root, CHECKLIST), '# Ship\n## Game\n- [ ] A goal\n## Store page (you)\n- [ ] An icon\n- [ ] Set to public\n')
  const s = shipStatus(root)
  assert.deepEqual(s.items.map((i) => [i.text, i.you]), [['A goal', false], ['An icon', true], ['Set to public', true]])
})

const lune = [join(homedir(), '.rokit', 'bin', 'lune'), '/usr/local/bin/lune', '/opt/homebrew/bin/lune'].find((p) => existsSync(p))

test('Lune check (real Lune, sandboxed): a change passes despite a test already failing on main, and fails when it breaks one', { skip: !lune || process.platform !== 'darwin' }, async () => {
  const dir = tmp('hangar-lune-base-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString().trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src' } } } }))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'Rules.luau'), 'return { speed = 20, water = 0.5 }\n')
  writeFileSync(
    join(dir, 'src', 'Rules.spec.luau'),
    'return function()\n  local Rules = require(script.Parent.Rules)\n  it("speed", function() expect(Rules.speed).to.equal(20) end)\n  it("water", function() expect(Rules.water).to.equal(0.3) end)\nend\n'
  )
  g('add', '.')
  g('commit', '-qm', 'main with one failing test')
  const base = g('rev-parse', 'HEAD')
  const project = { id: 'p', name: 'G', path: dir, createdAt: 1, settings: { ...DEFAULT_PROJECT_SETTINGS, checks: [], luauTests: { lune: true, testPlace: false } } } as Project
  const opts = { workDir: tmp('hangar-lune-work-'), appDataDir: tmp('hangar-lune-data-'), env: { ...process.env, PATH: `${join(homedir(), '.rokit', 'bin')}:${process.env.PATH}` } }
  const check = async (): Promise<{ status: string; output: string }> => {
    const head = g('rev-parse', 'HEAD')
    const r = await runChecks(project, { id: 'r', projectId: 'p', agentId: 'main', kind: 'code', title: 't', summary: '', baseSha: base, headSha: head, files: [], status: 'pending', createdAt: 1 } as unknown as Review, opts)
    const lunes = r!.results.find((x) => x.name === LUNE_CHECK_NAME)!
    return { status: lunes.status, output: lunes.output }
  }

  g('checkout', '-q', '-b', 'task-ok')
  writeFileSync(join(dir, 'src', 'Extra.luau'), 'return 1\n')
  g('add', '.')
  g('commit', '-qm', 'unrelated change')
  const ok = await check()
  assert.equal(ok.status, 'passed', ok.output)
  assert.match(ok.output, /Already failing before this change[^\n]*\n- src\/Rules\.spec\.luau > water/)

  g('checkout', '-q', '-b', 'task-bad')
  writeFileSync(join(dir, 'src', 'Rules.luau'), 'return { speed = 16, water = 0.5 }\n')
  g('commit', '-qam', 'breaks speed')
  const bad = await check()
  assert.equal(bad.status, 'failed', bad.output)
  assert.match(bad.output, /Broken by this change:\n- src\/Rules\.spec\.luau > speed/)
})
