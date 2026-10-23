import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings, Review } from '../src/shared/types'
import { AgentRunner, cleanResearch, publicWebUrl, type CanUseTool, type QueryFn } from '../src/main/agentRunner'
import { checksBlockedReason, checksFailed, runChecks, runsAsCode, sandboxCommand } from '../src/main/checks'
import { mergeWarnings } from '../src/shared/reviewRules'
import { isPublicAddress, WebEgressProxy } from '../src/main/webEgress'
import { CostTracker } from '../src/main/costs'
import { DEFAULT_PROJECT_SETTINGS, projectMcpServers, ProjectRegistry, sanitizeChecks } from '../src/main/projects'
import { gitSafetyEnv, gitStatus } from '../src/main/git'
import { evaluateToolUse, mayRevealSecrets } from '../src/main/permissions'
import { scrubProcessEnv } from '../src/main/env'
import { planSandbox } from '../src/main/sandbox'
import { isProtectedPath } from '../src/main/pathScope'
import { reviewProject } from '../src/main/projectTrust'
import type { Project } from '../src/shared/types'

const registryProject = (dir: string): Project => ({ id: 'p', name: 'p', path: dir, createdAt: 0, settings: { ...DEFAULT_PROJECT_SETTINGS } })
import { ReviewActions } from '../src/main/reviewActions'
import { ReviewPipeline } from '../src/main/reviewPipeline'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates, listRoles } from '../src/main/roles'
import { parseVerdict, TaskReviewer } from '../src/main/taskReviewer'
import { createVault } from '../src/main/vault'
import { helperPath } from '../src/main/clips'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick()
  }
}
const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 3, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }

function t0Sandbox(registry: ProjectRegistry, id: string): void {
  registry.update(id, { settings: { sandbox: false } })
}

/** A git project with roles, an autonomous runner driven by `script`, review actions and a pipeline. */
function setup(opts: { autonomous?: boolean; appDataDir?: string; script?: (prompt: string, options: Record<string, unknown>) => AsyncGenerator<unknown> } = {}) {
  const dir = tmp('hangar-x-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'game.luau'), 'print("v1")\n')
  writeFileSync(join(dir, 'CLAUDE.md'), 'SECRET-PROJECT-NOTES\n')
  installTemplates(dir)
  g('add', '.')
  g('commit', '-qm', 'init')
  const registry = new ProjectRegistry(join(tmp('hangar-x-reg-'), 'projects.json'))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { autonomous: opts.autonomous ?? true, reviewer: false } })
  const reviews = new ReviewStore(join(tmp('hangar-x-rv-'), 'reviews.json'))
  const events: AgentEvent[] = []
  const calls: { prompt: string; options: Record<string, unknown> }[] = []
  const auth: unknown[] = []
  const defaultScript = async function* (prompt: string, options: Record<string, unknown>) {
    yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
    if (prompt.includes('change')) writeFileSync(join(options.cwd as string, 'feature.luau'), `-- ${prompt}\n`)
    yield { type: 'assistant', message: { content: [{ type: 'text', text: `Did: ${prompt}` }] } }
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.1 }
  }
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (opts.script ?? defaultScript)(prompt, options)
  }
  let pipeline: ReviewPipeline | null = null
  const appDataDir = opts.appDataDir ?? tmp('hangar-x-appdata-')
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(tmp('hangar-x-c-'), 'costs.json')),
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test-key-123456',
    engineAuth: async (k, o) => {
      auth.push(o)
      return { env: { ANTHROPIC_API_KEY: k }, release: () => {} }
    },
    loadQuery: async () => query,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    },
    persistFile: join(tmp('hangar-x-p-'), 'agents.json'),
    trustFile: join(tmp('hangar-x-t-'), 'trust.json'),
    appDataDir,
    platform: 'linux',
    reviews,
    onReview: (r) => void pipeline?.start(r)
  })
  const workDir = tmp('hangar-x-work-')
  // No bubblewrap on this test machine: checks run unsandboxed unless a test turns the sandbox on.
  t0Sandbox(registry, project.id)
  const checkEnv: NodeJS.ProcessEnv = { ...process.env }
  const checkOpts: { platform?: NodeJS.Platform } = {}
  pipeline = new ReviewPipeline({ registry, reviews, emit: (e) => events.push(e), runChecks: (p, r) => runChecks(p, r, { workDir, appDataDir, env: checkEnv, platform: checkOpts.platform }), reviewer: null })
  const actions = new ReviewActions({ registry, reviews, runner, emit: (e) => events.push(e), publisher: null, pipeline })
  const status = (agentId: string) => runner.snapshot(project.id).find((a) => a.agentId === agentId)!.status
  return { dir, g, registry, project, runner, reviews, actions, events, calls, auth, status, workDir, checkEnv, checkOpts, setPipeline: (p: ReviewPipeline) => (pipeline = p) }
}

// ---------- checks ----------

test('checks: run on the task branch in a separate checkout, with a minimal environment', async () => {
  process.env.HANGAR_TEST_SECRET = 'do-not-leak-me'
  const t = setup()
  t.registry.update(t.project.id, { settings: { checks: [{ name: 'List', command: 'ls' }, { name: 'Env', command: 'env' }, { name: 'Fails', command: 'false' }, { name: 'Missing', command: 'no-such-tool-xyz src' }] } })
  t.runner.send(t.project.id, 'main', 'change the shop')
  await until(() => t.reviews.list()[0]?.checks?.status === 'done')
  const r = t.reviews.list()[0]!
  const by = (n: string) => r.checks!.results.find((x) => x.name === n)!
  assert.equal(by('List').status, 'passed')
  assert.match(by('List').output, /feature\.luau/, 'sees the task branch')
  assert.equal(existsSync(join(t.dir, 'feature.luau')), false, 'project folder untouched')
  assert.doesNotMatch(by('Env').output, /do-not-leak-me/, 'no secrets in the environment')
  assert.match(by('Env').output, /GIT_CONFIG_COUNT/)
  assert.equal(by('Fails').status, 'failed')
  assert.equal(by('Missing').status, 'error')
  assert.match(by('Missing').output, /PATH/)
  assert.ok(checksFailed(r.checks))
  assert.equal(t.g('worktree', 'list').trim().split('\n').length, 1, 'temporary checkout removed')
  delete process.env.HANGAR_TEST_SECRET
})

test('checks: failing checks make merge ask for "merge anyway"; passing checks merge straight away', async () => {
  const t = setup()
  t.registry.update(t.project.id, { settings: { checks: [{ name: 'Lint', command: 'false' }] } })
  t.runner.send(t.project.id, 'main', 'change one')
  await until(() => t.reviews.list()[0]?.checks?.status === 'done')
  const r = t.reviews.list()[0]!
  assert.deepEqual(t.actions.mergeWarnings(r), ['Checks failed: Lint.'])
  await assert.rejects(t.actions.merge(r.id), /Merge anyway/)
  await assert.rejects(t.actions.merge(r.id, { force: true }), /Something changed/, 'force only covers warnings the user saw')
  await t.actions.merge(r.id, { force: true, acknowledged: ['Checks failed: Lint.'] })
  assert.equal(t.reviews.get(r.id).status, 'merged')

  t.registry.update(t.project.id, { settings: { checks: [{ name: 'Ok', command: 'true' }] } })
  t.runner.send(t.project.id, 'main', 'change two')
  await until(() => t.reviews.list().length === 2 && t.reviews.list()[0]!.checks?.status === 'done')
  const r2 = t.reviews.list()[0]!
  assert.deepEqual(t.actions.mergeWarnings(r2), [])
  await t.actions.merge(r2.id)
})

test('checks: skipped when the task changed toolchain or protected files; commands must be plain words', async () => {
  const t = setup()
  const fake = { files: ['src/a.luau', 'rokit.toml'], headSha: 'x' } as unknown as Review
  assert.match((await checksBlockedReason(t.project, fake)) ?? '', /rokit\.toml/)
  assert.match((await checksBlockedReason(t.project, { ...fake, files: ['package.json'] })) ?? '', /package\.json/)
  assert.deepEqual(
    sanitizeChecks([{ name: 'ok', command: 'selene src' }, { command: 'selene src && curl evil.com' }, { command: 'stylua "$HOME"' }, { command: 'rojo build > out' }, { name: 'x', command: '' }]),
    [{ name: 'ok', command: 'selene src' }]
  )
})

// ---------- reviewer agent ----------

test('reviewer: parses the verdict, ignores junk, strips hidden characters', () => {
  const v = parseVerdict('Looks risky.\n```json\n{"verdict":"block","summary":"Remote trusts client\u202e","findings":[{"severity":"high","file":"src/Shop.server.luau","line":12,"title":"No price check","detail":"Client sends price."},{"title":""}]}\n```')
  assert.equal(v?.verdict, 'block')
  assert.equal(v?.summary, 'Remote trusts client')
  assert.equal(v?.findings.length, 1)
  assert.equal(v?.findings[0]!.line, 12)
  assert.equal(parseVerdict('no json here'), null)
  assert.equal(parseVerdict('```json\n{"verdict":"yes please"}\n```'), null)
})

test('reviewer: read-only in a separate checkout, never the real key, and its "block" makes merge ask', async () => {
  const t = setup()
  t.runner.send(t.project.id, 'main', 'change the shop')
  await until(() => t.reviews.list().length === 1)
  const review = t.reviews.list()[0]!
  const seen: { options?: Record<string, unknown>; prompt?: string; decisions: Record<string, string> } = { decisions: {} }
  const reviewerQuery: QueryFn = ({ prompt, options }) =>
    (async function* () {
      seen.options = options
      seen.prompt = prompt
      const can = options.canUseTool as CanUseTool
      const ac = new AbortController()
      for (const [name, input] of [
        ['Read', { file_path: join(options.cwd as string, 'feature.luau') }],
        ['Read', { file_path: '/etc/passwd' }],
        ['Edit', { file_path: join(options.cwd as string, 'feature.luau') }],
        ['Bash', { command: 'ls' }],
        ['WebFetch', { url: 'https://example.com' }]
      ] as const) {
        seen.decisions[`${name} ${JSON.stringify(input)}`] = (await can(name, input as Record<string, unknown>, { signal: ac.signal })).behavior
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"verdict":"block","summary":"Unvalidated remote.","findings":[]}\n```' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.05 }
    })()
  const hide: unknown[] = []
  const costs = new CostTracker(join(tmp('hangar-x-rc-'), 'costs.json'))
  const reviewer = new TaskReviewer({
    loadQuery: async () => reviewerQuery,
    getApiKey: () => 'sk-ant-real',
    getSettings: () => settings,
    engineAuth: async (_k, o) => {
      hide.push(o)
      return { env: { ANTHROPIC_API_KEY: 'proxy-token' }, release: () => {} }
    },
    costs,
    workDir: t.workDir
  })
  t.registry.update(t.project.id, { settings: { reviewer: true } })
  const pipeline = new ReviewPipeline({ registry: t.registry, reviews: t.reviews, emit: () => {}, runChecks: async () => null, reviewer })
  await pipeline.start(review)
  const after = t.reviews.get(review.id)
  assert.equal(after.aiReview?.status, 'done')
  assert.equal(after.aiReview?.verdict, 'block')
  assert.deepEqual(hide, [{ forceHideKey: true }])
  assert.notEqual(seen.options!.cwd, t.project.path, 'works in a temporary checkout')
  assert.deepEqual(seen.options!.mcpServers, {})
  assert.deepEqual(seen.options!.agents, {})
  assert.deepEqual(seen.options!.settingSources, [])
  assert.ok((seen.options!.disallowedTools as string[]).includes('Bash'))
  assert.ok((seen.options!.disallowedTools as string[]).includes('WebFetch'))
  assert.match(seen.prompt!, /\+-- change the shop/, 'the diff is in the prompt')
  const d = Object.entries(seen.decisions)
  assert.equal(d[0]![1], 'allow', 'reads inside the checkout')
  assert.ok(d.slice(1).every(([, v]) => v === 'deny'), JSON.stringify(d))
  assert.equal(costs.summary().todayUsd, 0.05)
  assert.ok(t.actions.mergeWarnings(after).some((w) => /reviewer/.test(w)))
  await assert.rejects(t.actions.merge(review.id), /Merge anyway/)
  assert.equal(t.g('worktree', 'list').trim().split('\n').length, 1)
})

// ---------- web researcher ----------

test('researcher: only web tools, no project access, never a subagent; findings become a research review', async () => {
  const decisions: Record<string, string> = {}
  const t = setup({
    script: async function* (prompt, options) {
      yield { type: 'system', subtype: 'init', session_id: 'r', mcp_servers: [] }
      if (prompt.includes('research')) {
        const can = options.canUseTool as CanUseTool
        const ac = new AbortController()
        for (const [name, input] of [
          ['WebSearch', { query: 'roblox datastore limits' }],
          ['WebFetch', { url: 'https://create.roblox.com/docs/cloud-services/data-stores' }],
          ['WebFetch', { url: 'http://127.0.0.1:47621/api/state' }],
          ['WebFetch', { url: 'http://localhost:8080/' }],
          ['WebFetch', { url: 'https://my-pc.tail1234.ts.net/' }],
          ['WebFetch', { url: 'file:///etc/passwd' }],
          ['WebFetch', { url: 'http://192.168.1.1/' }],
          ['Read', { file_path: 'game.luau' }],
          ['Bash', { command: 'ls' }]
        ] as const) {
          decisions[`${name} ${JSON.stringify(input)}`] = (await can(name, input as Record<string, unknown>, { signal: ac.signal })).behavior
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'DataStores allow 4MB per key.\u200b\n\n## Sources\n- https://create.roblox.com/docs/cloud-services/data-stores' }] } }
      } else {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.02 }
    }
  })
  assert.ok(listRoles(t.dir).some((r) => r.id === 'researcher' && r.mode === 'research'))
  t.runner.send(t.project.id, 'researcher', 'research DataStore limits')
  await until(() => t.reviews.list().length === 1)
  const call = t.calls.find((c) => c.prompt.includes('research'))!
  const o = call.options
  assert.notEqual(o.cwd, t.project.path, 'an empty folder, not the project')
  assert.deepEqual(o.mcpServers, {}, 'no Studio or project tool servers')
  assert.deepEqual(o.agents, {}, 'no subagents')
  for (const tool of ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'Task']) assert.ok((o.disallowedTools as string[]).includes(tool), tool)
  assert.doesNotMatch(String((o.systemPrompt as { append: string }).append), /SECRET-PROJECT-NOTES/, 'CLAUDE.md is not given to the researcher')
  assert.deepEqual(t.auth.at(-1), { forceHideKey: true }, 'never holds the real key')
  assert.equal(existsSync(o.cwd as string), false, 'its temporary folder is removed')
  const d = Object.values(decisions)
  assert.deepEqual(d, ['allow', 'allow', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny'], JSON.stringify(decisions))

  const r = t.reviews.list()[0]!
  assert.equal(r.kind, 'research')
  assert.equal(r.branch, '', 'no task branch, even in autonomous mode')
  assert.equal(t.g('branch', '--list', 'hangar/*').trim(), '')
  assert.deepEqual(r.research!.fetched, ['https://create.roblox.com/docs/cloud-services/data-stores'])
  assert.deepEqual(r.research!.queries, ['roblox datastore limits'])
  assert.equal(r.research!.hiddenChars, true)
  assert.doesNotMatch(r.research!.markdown, /\u200b/)
  assert.match(r.note ?? '', /hidden/)
  assert.equal(r.checks, undefined, 'no checks for research')

  // Other agents never get the researcher as a subagent, and don't see research before approval.
  t.runner.send(t.project.id, 'lead', 'plan the shop')
  await until(() => t.calls.length === 2 && t.status('lead') === 'idle' && !t.runner.projectBusy(t.project.id))
  const lead = t.calls[1]!.options
  assert.ok(!Object.keys(lead.agents as object).includes('researcher'))
  assert.doesNotMatch(String((lead.systemPrompt as { append: string }).append), /research\/ folder/)

  // Approving saves it to research/ and commits only that file.
  writeFileSync(join(t.dir, 'scratch.txt'), 'uncommitted user work')
  t.registry.update(t.project.id, { settings: { autonomous: false } })
  const approved = await t.actions.merge(r.id)
  assert.equal(approved.status, 'merged')
  const saved = approved.research!.savedAs!
  assert.match(saved, /^research\/\d{4}-\d{2}-\d{2}-research-datastore-limits\.md$/)
  const text = readFileSync(join(t.dir, saved), 'utf8')
  assert.match(text, /approved by the user/)
  assert.match(text, /pages_opened:\n {2}- "https:\/\/create\.roblox\.com/)
  assert.match(t.g('log', '-1', '--format=%s', '--name-only'), /Research: research DataStore limits\n+research\//)
  assert.match(t.g('status', '--porcelain'), /\?\? scratch\.txt/, "the user's other work stays uncommitted")

  // Now other agents are told about research/.
  t.runner.send(t.project.id, 'lead', 'plan again')
  await until(() => t.calls.length === 3 && t.status('lead') === 'idle')
  assert.match(String((t.calls[2]!.options.systemPrompt as { append: string }).append), /research\/ folder holds web research the user reviewed/)
})

test('researcher: discard keeps nothing; research reviews have no branch actions', async () => {
  const t = setup({
    script: async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Findings.' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  t.runner.send(t.project.id, 'researcher', 'look into tweens')
  await until(() => t.reviews.list().length === 1)
  const r = t.reviews.list()[0]!
  assert.equal(await t.actions.diff(r.id), 'Findings.')
  await assert.rejects(t.actions.checkout(r.id), /no branch/)
  await assert.rejects(t.actions.publish(r.id), /nothing to publish/)
  await t.actions.discard(r.id)
  assert.equal(existsSync(join(t.dir, 'research')), false)
})

test('researcher: web address rules and report cleaning', () => {
  for (const ok of ['https://create.roblox.com/docs', 'http://devforum.roblox.com/t/1', 'https://github.com/Roblox/x']) assert.ok(publicWebUrl(ok), ok)
  for (const bad of [
    'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.5/', 'http://2130706433/', 'http://0x7f000001/', 'https://pc.local/',
    'https://box.tailabc.ts.net/', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'http://intranet/', 'not a url', 42
  ]) {
    assert.equal(publicWebUrl(bad), false, String(bad))
  }
  const c = cleanResearch('See https://a.example.com/x) and https://b.example.org/y. \u2066hidden\u2069')
  assert.equal(c.hiddenChars, true)
  assert.deepEqual(c.cited, ['https://a.example.com/x', 'https://b.example.org/y'])
})

// ---------- design vault ----------

test('design vault: the Lead keeps a game design vault with design templates and instructions', async () => {
  const t = setup({ autonomous: false })
  const lead = listRoles(t.dir).find((r) => r.id === 'lead')!
  assert.equal(lead.vault, 'design-vault')
  assert.equal(lead.vaultKind, 'design')
  t.runner.send(t.project.id, 'lead', 'plan the shop')
  await until(() => t.calls.length === 1 && t.status('lead') === 'idle')
  assert.ok(existsSync(join(t.dir, 'design-vault', 'Game Overview.md')))
  assert.ok(existsSync(join(t.dir, 'design-vault', 'Mechanics', '_Template.md')))
  assert.match(readFileSync(join(t.dir, 'design-vault', 'Mechanics', '_Template.md'), 'utf8'), /Acceptance criteria/)
  assert.match(String((t.calls[0]!.options.systemPrompt as { append: string }).append), /game design knowledge base/)
  // UI vaults still get the UI templates.
  const other = tmp('hangar-x-v-')
  createVault(other, 'ui-vault')
  assert.ok(existsSync(join(other, 'ui-vault', 'Style Guide.md')))
})

// ---------- audit fixes ----------

test('audit: checks run in the OS sandbox on macOS/Linux, and refuse to run unsandboxed when it is missing', async () => {
  const home = tmp('hangar-x-home-')
  const fakeBin = tmp('hangar-x-bin-')
  writeFileSync(join(fakeBin, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 })
  const mac = sandboxCommand('darwin', '/usr/local/bin/selene', ['src'], { work: '/w/check-1', appDataDir: '/Users/me/Library/Application Support/Hangar', home })
  if (mac) {
    const profile = mac.argv[1]!
    assert.match(profile, /\(deny network\*\)/)
    assert.match(profile, /\(deny file-write\*\)/)
    assert.match(profile, /\(deny file-read\* \(subpath "[^"]*\.ssh"\)\)/)
    assert.match(profile, /Application Support\/Hangar/)
    assert.deepEqual(mac.argv.slice(2), ['/usr/local/bin/selene', 'src'])
  }
  const lin = sandboxCommand('linux', '/usr/bin/selene', ['src'], { work: '/w/check-1', appDataDir: '/home/me/.config/Hangar', home, env: { PATH: fakeBin } })!
  assert.equal(lin.file, join(fakeBin, 'bwrap'))
  assert.ok(lin.argv.includes('--unshare-net'))
  assert.deepEqual(lin.argv.slice(0, 3), ['--ro-bind', '/', '/'])
  assert.deepEqual(lin.argv.slice(-2), ['/usr/bin/selene', 'src'])
  assert.equal(sandboxCommand('linux', 'x', [], { work: '/w', appDataDir: '/a', env: { PATH: tmp('hangar-x-empty-') } }), null)
  assert.equal(sandboxCommand('win32', 'x', [], { work: '/w', appDataDir: '/a' }), null)

  // Sandbox on, Linux, no bubblewrap: the check reports it instead of running unsandboxed.
  const t = setup()
  t.registry.update(t.project.id, { settings: { sandbox: true, checks: [{ name: 'List', command: 'ls' }] } })
  t.checkOpts.platform = 'linux'
  t.checkEnv.PATH = (process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'bwrap'))).join(':')
  t.runner.send(t.project.id, 'main', 'change it')
  await until(() => t.reviews.list()[0]?.checks?.status === 'done')
  const res = t.reviews.list()[0]!.checks!.results[0]!
  assert.equal(res.status, 'error')
  assert.match(res.output, /bubblewrap/)
})

test('audit: changes to files that run as code skip the checks, and skipped checks make Merge ask', async () => {
  for (const f of ['eslint.config.js', 'tools/prettier.config.mjs', '.eslintrc.cjs', 'tsconfig.json', 'node.bat', 'src/git.exe', 'scripts/x.ps1', 'node', 'bin/rojo']) {
    assert.ok(runsAsCode(f), f)
  }
  for (const f of ['src/server/Shop.server.luau', 'default.project.json', 'selene.toml', 'docs/config.md']) assert.equal(runsAsCode(f), false, f)
  const t = setup()
  t.registry.update(t.project.id, { settings: { checks: [{ name: 'Ok', command: 'true' }] } })
  t.runner.send(t.project.id, 'main', 'change it')
  await until(() => t.reviews.list()[0]?.checks?.status === 'done')
  const r = t.reviews.list()[0]!
  const skipped: Review = { ...r, checks: { status: 'skipped', reason: 'Not run automatically: this task changed eslint.config.js', results: [] } }
  assert.match(mergeWarnings(skipped)[0]!, /Checks didn't run/)
  const failedReviewer: Review = { ...r, aiReview: { status: 'error', verdict: null, summary: '', findings: [], costUsd: 0, error: 'budget' } }
  assert.match(mergeWarnings(failedReviewer).join(' '), /reviewer agent didn't finish/)
})

test('audit: a researcher never resumes or keeps a session, and its web traffic goes through the filter proxy', async () => {
  const t = setup({
    script: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'web-session', mcp_servers: [] }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Report.' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, session_id: 'web-session' }
    }
  })
  t.runner.send(t.project.id, 'researcher', 'one')
  await until(() => t.reviews.list().length === 1)
  t.runner.send(t.project.id, 'researcher', 'two')
  await until(() => t.reviews.list().length === 2)
  assert.equal(t.calls[1]!.options.resume, undefined)
  assert.equal(t.runner.snapshot(t.project.id).find((a) => a.agentId === 'researcher')!.sessionId, null)

  const egress = new WebEgressProxy(async (host) => (host === 'docs.example.com' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]))
  assert.equal(await egress.check('docs.example.com'), '93.184.216.34')
  assert.equal(await egress.check('127.0.0.1.nip.io'), null, 'a public-looking name that resolves to this computer')
  assert.equal(await egress.check('localhost'), null)
  assert.equal(await egress.check('10.0.0.1'), null)
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '100.100.1.1', '169.254.169.254', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '::7f00:1', '::ffff:7f00:1', '::ffff:a00:1', 'fec0::1', '64:ff9b:1::a00:1']) {
    assert.equal(isPublicAddress(a), false, a)
  }
  for (const a of ['93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34', '::ffff:5db8:d822']) assert.equal(isPublicAddress(a), true, a)
  const url = await egress.start()
  const port = Number(new URL(url).port)
  const connectReply = (auth: string | null) =>
    new Promise<string>((resolveReply) => {
      const sock = netConnect(port, '127.0.0.1', () =>
        sock.write(`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`)
      )
      let data = ''
      sock.on('data', (d) => (data += d.toString()))
      sock.on('close', () => resolveReply(data))
    })
  assert.match(await connectReply(null), /^HTTP\/1\.1 407/, 'no credentials: refused')
  assert.match(await connectReply('run:wrong-token'), /^HTTP\/1\.1 407/)
  const grant = await egress.issue()
  const pass = decodeURIComponent(new URL(grant.url).password)
  assert.match(await connectReply(`run:${pass}`), /^HTTP\/1\.1 403/, 'with credentials: blocked because evil.example resolves to this computer')
  grant.release()
  assert.match(await connectReply(`run:${pass}`), /^HTTP\/1\.1 407/, 'credentials stop working when the run ends')
  const plain = await fetch(`${url}/`).then((r) => r.status)
  assert.equal(plain, 403)
  egress.stop()

  // With a proxy configured, the researcher's engine environment points at it.
  const withProxy = setup({
    script: async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Report.' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  ;(withProxy.runner as unknown as { deps: { researchProxy: () => Promise<{ url: string; release: () => void }> } }).deps.researchProxy = async () => ({ url: 'http://127.0.0.1:5555', release: () => {} })
  withProxy.runner.send(withProxy.project.id, 'researcher', 'three')
  await until(() => withProxy.reviews.list().length === 1)
  const env = withProxy.calls[0]!.options.env as Record<string, string>
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:5555')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
})

test('audit: the reviewer has no pre-approved tools; research and vault folders that are links are refused', async () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'taskReviewer.ts'), 'utf8')
  assert.doesNotMatch(src, /^\s*allowedTools:/m)

  const outside = tmp('hangar-x-outside-')
  const proj = tmp('hangar-x-linkvault-')
  symlinkSync(outside, join(proj, 'ui-vault'))
  assert.throws(() => createVault(proj, 'ui-vault'), /link/)
  assert.equal(existsSync(join(outside, 'Home.md')), false)

  const t = setup({
    autonomous: false,
    script: async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Findings.' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  symlinkSync(outside, join(t.dir, 'research'))
  t.runner.send(t.project.id, 'researcher', 'link test')
  await until(() => t.reviews.list().length === 1)
  await assert.rejects(t.actions.merge(t.reviews.list()[0]!.id), /link/)
  assert.deepEqual(readdirSync(outside), [])
})

test('audit: helper programs (ffmpeg, PowerShell, osascript) are only ever run by absolute path', () => {
  const bin = tmp('hangar-x-ff-')
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(helperPath('ffmpeg', 'linux', { PATH: bin }), join(bin, 'ffmpeg'))
  assert.equal(helperPath('ffmpeg', 'linux', { PATH: '.' }), null, 'relative PATH entries are ignored')
  assert.equal(helperPath('powershell', 'win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(helperPath('osascript', 'darwin'), '/usr/bin/osascript')
  assert.equal(helperPath('screencapture', 'darwin'), '/usr/sbin/screencapture')
})

// ---------- second full audit (agent layer) ----------

test('audit2: the forced hooks folder can never be created, so planted hooks never run', async () => {
  const env = gitSafetyEnv()
  const i = Object.entries(env).find(([k, v]) => k.startsWith('GIT_CONFIG_KEY_') && v === 'core.hooksPath')![0].replace('KEY', 'VALUE')
  const hooks = env[i]!
  assert.throws(() => mkdirSync(hooks, { recursive: true }))
  // A repo where an agent tried to plant a post-checkout hook: Hangar's checkout doesn't run it.
  const dir = tmp('hangar-x-hooks-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: { ...process.env, ...env } }).toString()
  g('init', '-q', '-b', 'main')
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x')
  const marker = join(dir, 'HOOK_RAN')
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  g('checkout', '-q', '-b', 'other')
  assert.equal(existsSync(marker), false)
})

test('audit2: git refuses repos whose working tree is elsewhere, or a subfolder of a bigger repo', async () => {
  const outer = tmp('hangar-x-outer-')
  execFileSync('git', ['init', '-q'], { cwd: outer })
  const sub = join(outer, 'game')
  mkdirSync(sub)
  await assert.rejects(gitStatus(sub), /bigger git repository/)

  const home = tmp('hangar-x-fakehome-')
  const proj = join(home, 'proj')
  mkdirSync(proj)
  writeFileSync(join(home, 'id_rsa'), 'secret')
  execFileSync('git', ['init', '-q'], { cwd: proj })
  execFileSync('git', ['config', 'core.worktree', '..'], { cwd: proj })
  await assert.rejects(gitStatus(proj), /core\.worktree|bigger git repository/)
})

test('audit2: git-ignored files an autonomous task creates or changes are moved out of the project', async () => {
  const t = setup({
    script: async function* (_prompt, options) {
      const cwd = options.cwd as string
      writeFileSync(join(cwd, 'feature.luau'), '-- tracked change\n')
      mkdirSync(join(cwd, 'Packages'), { recursive: true })
      writeFileSync(join(cwd, 'Packages', 'Evil.luau'), 'require(123)')
      writeFileSync(join(cwd, '.env'), 'CHANGED=1')
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  writeFileSync(join(t.dir, '.gitignore'), 'Packages/\n.env\nkeep.log\n')
  writeFileSync(join(t.dir, '.env'), 'ORIGINAL=1')
  writeFileSync(join(t.dir, 'keep.log'), 'untouched')
  t.g('add', '.gitignore')
  t.g('commit', '-qm', 'ignore')
  t.runner.send(t.project.id, 'main', 'change things')
  await until(() => t.reviews.list().length === 1)
  const r = t.reviews.list()[0]!
  assert.deepEqual(r.files, ['feature.luau'])
  assert.equal(existsSync(join(t.dir, 'Packages', 'Evil.luau')), false, 'new ignored file moved out')
  assert.equal(existsSync(join(t.dir, '.env')), false, 'changed ignored file moved out')
  assert.equal(readFileSync(join(t.dir, 'keep.log'), 'utf8'), 'untouched', 'untouched ignored files stay')
  assert.match(r.note ?? '', /git-ignored files .*Packages\/Evil\.luau/)
  const qdir = /to (\S+quarantine\S+)\.$/.exec(r.note ?? '')
  assert.ok(qdir && existsSync(join(qdir[1]!, 'Packages', 'Evil.luau')), 'kept in quarantine for inspection')
})

test('audit2: ignored files that cannot be moved out are named in the review', async () => {
  // App data is a file, so the quarantine folder can't be created.
  const blocked = join(tmp('hangar-x-blocked-'), 'not-a-folder')
  writeFileSync(blocked, '')
  const t = setup({
    appDataDir: blocked,
    script: async function* (_prompt, options) {
      const cwd = options.cwd as string
      writeFileSync(join(cwd, 'feature.luau'), '-- tracked change\n')
      mkdirSync(join(cwd, 'Packages'), { recursive: true })
      writeFileSync(join(cwd, 'Packages', 'Evil.luau'), 'require(123)')
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  writeFileSync(join(t.dir, '.gitignore'), 'Packages/\n')
  t.g('add', '.gitignore')
  t.g('commit', '-qm', 'ignore')
  t.runner.send(t.project.id, 'main', 'change things')
  await until(() => t.reviews.list().length === 1)
  assert.match(t.reviews.list()[0]!.note ?? '', /couldn't move out \(Packages\/Evil\.luau\)/)
})

test('audit2: edits through links ask in red, and a write that ends up outside stops the run', async () => {
  const outside = tmp('hangar-x-out2-')
  const t = setup({ autonomous: false })
  symlinkSync(outside, join(t.dir, 'src-link'))
  const d = evaluateToolUse({ toolName: 'Write', input: { file_path: join(t.dir, 'src-link', 'x.luau') }, projectRoot: t.dir, settings: { ...t.project.settings, autoApproveEdits: true } })
  assert.equal(d.action, 'ask')
  assert.equal(d.action === 'ask' && d.dangerous, true)

  const t2 = setup({
    autonomous: false,
    script: async function* (_p, options) {
      const hook = (options.hooks as { PostToolUse: { matcher: string; hooks: ((i: unknown) => Promise<Record<string, unknown>>)[] }[] }).PostToolUse[0]!
      assert.match(hook.matcher, /Write/)
      const ok = await hook.hooks[0]!({ tool_input: { file_path: join(options.cwd as string, 'fine.luau') } })
      assert.deepEqual(ok, {})
      symlinkSync(outside, join(options.cwd as string, 'swapped'))
      const bad = await hook.hooks[0]!({ tool_input: { file_path: join(options.cwd as string, 'swapped', 'x.luau') } })
      assert.equal(bad.continue, false)
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    }
  })
  t2.runner.send(t2.project.id, 'main', 'write')
  await until(() => t2.status('main') === 'stopped' || t2.status('main') === 'idle')
  assert.equal(t2.status('main'), 'stopped')
  assert.ok(t2.runner.snapshot(t2.project.id)[0]!.log.some((e) => /went through a link/.test(e.text)))
})

test('audit2: review actions hold the project, so no task can start in the middle of a merge', async () => {
  const t = setup()
  let release!: () => void
  const held = t.runner.withProjectLock(t.project.id, () => new Promise<void>((r) => (release = r)))
  t.runner.send(t.project.id, 'main', 'change while merging')
  await tick(30)
  assert.equal(t.calls.length, 0, 'task waits')
  await assert.rejects(t.runner.withProjectLock(t.project.id, async () => 1), /working in this project/)
  release()
  await held
  await until(() => t.calls.length === 1)
})

test('audit2: assorted hardening', async () => {
  // Look-alike names for the Studio server are dropped.
  const dir = tmp('hangar-x-mcp-')
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'Roblox-Studio': { command: 'x' }, roblox_studio: { command: 'y' }, blender: { command: 'z' } } }))
  assert.deepEqual(Object.keys(projectMcpServers(dir)), ['blender'])
  // More ways to print secrets.
  for (const c of ['cat /proc/self/environ', 'node -p process.env', 'python -c "import os;print(os.environ)"', 'echo $GIT_CONFIG_VALUE_1']) assert.ok(mayRevealSecrets(c), c)
  assert.equal(evaluateToolUse({ toolName: 'PowerShell', input: { command: 'Get-ChildItem env:' }, projectRoot: dir, settings: DEFAULT_PROJECT_SETTINGS }).action, 'ask')
  // Credential-looking variables are removed from Hangar's own environment.
  const env: NodeJS.ProcessEnv = { PATH: '/bin', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', MY_API_KEY: 'z', ELECTRON_RENDERER_URL: 'u', LANG: 'en' }
  assert.deepEqual(scrubProcessEnv(env).sort(), ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'MY_API_KEY'])
  assert.deepEqual(Object.keys(env).sort(), ['ELECTRON_RENDERER_URL', 'LANG', 'PATH'])
  // Sandbox write-denies nested package.json, node_modules and tool configs anywhere.
  const plan = planSandbox({ ...registryProject(dir) }, { platform: 'darwin', appDataDir: '/a' })
  const deny = (plan.settings!.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite
  for (const n of ['package.json', 'node_modules', 'Makefile', 'rokit.toml', '.github']) assert.ok(deny.includes(join(dir, '**', n)), n)
  // Edits inside node_modules ask in red.
  const nm = evaluateToolUse({ toolName: 'Edit', input: { file_path: join(dir, 'node_modules', 'x', 'index.js') }, projectRoot: dir, settings: { ...DEFAULT_PROJECT_SETTINGS, autonomous: true } })
  assert.equal(nm.action === 'ask' && nm.dangerous, true)
  // A vault path through a link creates nothing outside.
  const outside = tmp('hangar-x-vout-')
  const proj = tmp('hangar-x-vproj-')
  symlinkSync(outside, join(proj, 'notes'))
  assert.throws(() => createVault(proj, 'notes/ui'), /link/)
  assert.deepEqual(readdirSync(outside), [])
})

test('audit2: sandboxed auto-run hides the real key; `node .` MCP servers hash their main file', async () => {
  const t = setup({ autonomous: false })
  t.registry.update(t.project.id, { settings: { autoApproveEdits: true, sandbox: true } })
  ;(t.runner as unknown as { deps: { platform: string } }).deps.platform = 'darwin'
  t.runner.send(t.project.id, 'main', 'hello')
  await until(() => t.calls.length === 1)
  assert.deepEqual(t.auth.at(-1), { forceHideKey: true })

  const dir = tmp('hangar-x-node-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'server/index.js' }))
  mkdirSync(join(dir, 'server'))
  writeFileSync(join(dir, 'server', 'index.js'), 'v1')
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tool: { command: 'node', args: ['.'] } } }))
  const p = registryProject(dir)
  const before = (await reviewProject(p)).hash
  writeFileSync(join(dir, 'server', 'index.js'), 'v2')
  assert.notEqual((await reviewProject(p)).hash, before)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'server/index.js', scripts: { x: 'y' } }))
  assert.equal(isProtectedPath('server/index.js', dir), true)
})
