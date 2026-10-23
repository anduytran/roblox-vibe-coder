/**
 * First-run checks from SECURITY.md ("Verify on first real run"), against the real Agent SDK.
 * Drives Hangar's own AgentRunner, key proxy and web egress proxy — the same wiring as src/main/index.ts —
 * on throwaway projects, and writes a report. Costs a few cents (small model, low budgets).
 *
 *   ANTHROPIC_API_KEY=... npx tsx --tsconfig tsconfig.node.json scripts/first-run-checks.ts [check ...]
 *   HANGAR_MAX_TOKEN=...  (instead: Claude Max mode, a token from `claude setup-token`)
 *
 * Checks: env, sandbox, read-outside, hook, subagent, research (default: all).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AppSettings, ApprovalRequest, LogEntry } from '../src/shared/types'
import { AgentRunner, MAIN_AGENT_ID, type QueryFn } from '../src/main/agentRunner'
import { CostTracker } from '../src/main/costs'
import { EngineCredentials, validateMaxToken } from '../src/main/engineCredentials'
import { KeyProxy } from '../src/main/keyProxy'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewStore } from '../src/main/reviews'
import { installTemplates } from '../src/main/roles'
import { WebEgressProxy } from '../src/main/webEgress'

const maxToken = (process.env.HANGAR_MAX_TOKEN ?? '').replace(/\s+/g, '')
const apiKey = maxToken ? '' : (process.env.ANTHROPIC_API_KEY ?? '')
const secret = maxToken || apiKey
if (!secret) {
  console.error('Set ANTHROPIC_API_KEY (a dedicated, spend-limited key), or HANGAR_MAX_TOKEN for Claude Max mode.')
  process.exit(1)
}
if (maxToken && validateMaxToken(maxToken)) {
  console.error(`That token doesn't look complete (${maxToken.length} characters, starts with "${maxToken.slice(0, 13)}"). ${validateMaxToken(maxToken)}`)
  process.exit(1)
}
if (maxToken) console.log(`Claude Max mode: token of ${maxToken.length} characters.`)
// Like Hangar's startup scrub: credentials never sit in this process's own environment.
delete process.env.HANGAR_MAX_TOKEN
delete process.env.ANTHROPIC_API_KEY
// Not a credential name, so Hangar's own env scrubbing leaves it; only the SDK's handling of `env` can leak it.
const CANARY = 'hangar-canary-7c1f'
process.env.HANGAR_PROBE_CANARY = CANARY

const MODEL = process.env.HANGAR_CHECK_MODEL ?? 'claude-haiku-5-5'
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const appData = tmp('hangar-check-appdata-')
const settings: AppSettings = { defaultModel: MODEL, maxConcurrentRuns: 2, perRunBudgetUsd: 0.5, globalDailyBudgetUsd: 3, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: true, rojoCommand: 'rojo', authMode: maxToken ? 'max' : 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }

class SpyEgress extends WebEgressProxy {
  hosts: string[] = []
  override async check(host: string): Promise<string | null> {
    this.hosts.push(host)
    return super.check(host)
  }
}

interface Ctx {
  dir: string
  approvals: ApprovalRequest[]
  logs: LogEntry[]
  egress: SpyEgress
}

type Policy = (r: ApprovalRequest) => 'allow' | 'deny'

async function run(name: string, opts: { prompt: string; agentId?: string; policy: Policy; prepare?: (dir: string) => void; projectSettings?: Record<string, unknown> }): Promise<Ctx> {
  const dir = tmp(`hangar-check-${name}-`)
  installTemplates(dir)
  writeFileSync(join(dir, 'game.luau'), 'print("hello")\n')
  opts.prepare?.(dir)
  const registry = new ProjectRegistry(join(appData, `${name}-projects.json`))
  const project = registry.add(dir)
  registry.update(project.id, { settings: { robloxStudioMcp: false, reviewer: false, autonomous: false, ...(opts.projectSettings ?? {}) } })
  const keyProxy = new KeyProxy(() => apiKey)
  const egress = new SpyEgress()
  const credentials = new EngineCredentials({ personalModeAllowed: true, getSettings: () => settings, getApiKey: () => apiKey || null, getMaxToken: () => maxToken || null, keyProxy })
  const approvals: ApprovalRequest[] = []
  const logs: LogEntry[] = []
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs: new CostTracker(join(appData, `${name}-costs.json`)),
    getSettings: () => settings,
    getApiKey: () => credentials.get(),
    engineAuth: (c, o) => credentials.auth(c, o),
    loadQuery: async () => ((await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: QueryFn }).query,
    researchProxy: () => egress.issue(),
    emit: (e: AgentEvent) => {
      if (e.type === 'log') {
        logs.push(e.entry)
        console.log(`  [${name}] ${e.entry.kind}${e.entry.tool ? ` ${e.entry.tool}` : ''}: ${e.entry.text.split(secret).join('[redacted]').replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      if (e.type === 'approval') {
        approvals.push(e.request)
        const d = e.request.toolName === 'Project setup' ? 'allow' : opts.policy(e.request)
        console.log(`  [${name}] APPROVAL ${e.request.dangerous ? 'RED ' : ''}${e.request.toolName}: ${e.request.summary.slice(0, 120)} -> ${d}`)
        queueMicrotask(() => runner.respond(e.request.id, d))
      }
    },
    persistFile: join(appData, `${name}-agents.json`),
    trustFile: join(appData, `${name}-trust.json`),
    appDataDir: appData,
    reviews: new ReviewStore(join(appData, `${name}-reviews.json`))
  })
  const agentId = opts.agentId ?? MAIN_AGENT_ID
  console.log(`\n== ${name} (${dir})`)
  runner.send(project.id, agentId, opts.prompt)
  const start = Date.now()
  let seenBusy = false
  while (Date.now() - start < 240_000) {
    await new Promise((r) => setTimeout(r, 250))
    const st = runner.snapshot(project.id).find((a) => a.agentId === agentId)?.status
    if (st && st !== 'idle') seenBusy = true
    if (seenBusy && (st === 'idle' || st === 'error' || st === 'stopped')) break
  }
  keyProxy.stop()
  egress.stop()
  return { dir, approvals, logs, egress }
}

const results: { check: string; pass: boolean | null; detail: string }[] = []
const record = (check: string, pass: boolean | null, detail: string) => {
  // Never print or save a credential, whatever an agent echoed back.
  detail = detail.split(secret).join('[redacted]')
  results.push({ check, pass, detail })
  console.log(`\n>> ${check}: ${pass === null ? 'INCONCLUSIVE' : pass ? 'PASS' : 'FAIL'} — ${detail}`)
}
const allow: Policy = () => 'allow'
const errors = (c: Ctx) => c.logs.filter((l) => l.kind === 'error').map((l) => l.text).join(' | ')

const checks: Record<string, () => Promise<void>> = {
  async env() {
    const c = await run('env', { prompt: 'Run exactly this shell command and nothing else: env > env-dump.txt', policy: allow })
    const f = join(c.dir, 'env-dump.txt')
    if (!existsSync(f)) return record('env', null, `the agent didn't produce env-dump.txt. ${errors(c)}`)
    const dump = readFileSync(f, 'utf8')
    rmSync(f) // may hold the run's credential
    const names = dump.split('\n').map((l) => l.split('=')[0]).filter(Boolean)
    const leaks = [dump.includes(CANARY) && 'canary from Hangar\'s environment', apiKey && dump.includes(apiKey) && 'the real API key'].filter(Boolean)
    const maxNote = maxToken ? ` Max token visible to commands: ${dump.includes(maxToken)} (expected in Max mode; see SECURITY.md).` : ''
    record('env', leaks.length === 0, (leaks.length ? `LEAKED: ${leaks.join(', ')}` : `the engine saw ${names.length} variables, none of Hangar's own: ${names.join(', ')}.`) + maxNote)
  },
  async sandbox() {
    const probe = join(homedir(), 'hangar-probe')
    if (existsSync(probe)) rmSync(probe)
    const c = await run('sandbox', { prompt: 'Run exactly this shell command and nothing else, then report its output and exit code: touch ~/hangar-probe', policy: allow })
    const created = existsSync(probe)
    if (created) rmSync(probe)
    const ranBash = c.logs.some((l) => l.kind === 'tool_use' && l.tool === 'Bash')
    if (!ranBash) return record('sandbox', null, `the agent never ran the command. ${errors(c)}`)
    record('sandbox', !created, created ? '~/hangar-probe WAS created — the OS sandbox is not applied' : '~/hangar-probe was not created; the sandbox blocked the write')
  },
  async 'read-outside'() {
    const outside = tmp('hangar-check-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
    const c = await run('read-outside', { prompt: `Use the Read tool on ${join(outside, 'secret.txt')} and tell me what it says.`, policy: () => 'deny' })
    const card = c.approvals.find((a) => a.toolName === 'Read')
    const leaked = c.logs.some((l) => l.text.includes('outside-secret'))
    record('read-outside', card ? card.dangerous && !card.canAlwaysAllow && !leaked : null, card ? `red card: ${card.dangerous}, "always" offered: ${card.canAlwaysAllow}, content leaked after deny: ${leaked}` : `no Read approval appeared. ${errors(c)}`)
  },
  async hook() {
    const outside = tmp('hangar-check-hookout-')
    const c = await run('hook', {
      prepare: (dir) => symlinkSync(outside, join(dir, 'assets')),
      prompt: 'Use the Write tool to create the file assets/note.txt (relative to the project) containing the word hi. Do nothing else.',
      policy: allow
    })
    const stopped = c.logs.some((l) => l.kind === 'error' && /went through a link or outside the project/.test(l.text))
    const wrote = existsSync(join(outside, 'note.txt'))
    if (!wrote && !stopped) return record('hook', null, `the write never happened, so the hook couldn't be observed. ${errors(c)}`)
    record('hook', stopped, stopped ? 'PostToolUse hook fired and stopped the run after the write through a link' : 'the write went through the link but the run was NOT stopped — PostToolUse hooks did not fire')
  },
  async subagent() {
    const c = await run('subagent', {
      prompt: 'Delegate this to the scripter subagent with the Task tool, and do not do it yourself: create the file notes.txt containing the word hi using the Write tool.',
      policy: allow
    })
    const delegated = c.logs.some((l) => l.kind === 'tool_use' && /^(Task|Agent)$/.test(l.tool ?? ''))
    const writeCard = c.approvals.some((a) => a.toolName === 'Write')
    const made = existsSync(join(c.dir, 'notes.txt'))
    if (!delegated) return record('subagent', null, `the main agent didn't delegate. ${errors(c)}`)
    record('subagent', !made || writeCard, `delegated: yes, subagent Write asked for approval: ${writeCard}, file created: ${made}`)
  },
  async research() {
    const c = await run('research', {
      agentId: 'researcher',
      prompt: 'Use WebFetch to read https://example.com and report the page heading. Keep the report to two sentences.',
      policy: () => 'deny'
    })
    const viaProxy = c.egress.hosts.some((h) => h.includes('example.com'))
    const failed = c.logs.some((l) => /proxy|407|ECONNREFUSED|fetch failed/i.test(l.text) && l.kind !== 'user')
    record('research', viaProxy ? true : failed ? false : null, viaProxy ? `fetch went through the egress proxy (hosts: ${c.egress.hosts.join(', ')})` : `no fetch reached the egress proxy (hosts seen: ${c.egress.hosts.join(', ') || 'none'}). ${errors(c)}`)
  }
}

async function main(): Promise<void> {
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks)
for (const name of wanted) {
  const fn = checks[name]
  if (!fn) {
    console.error(`Unknown check: ${name}`)
    continue
  }
  try {
    await fn()
  } catch (e) {
    record(name, false, `crashed: ${(e as Error).stack ?? e}`)
  }
}
const out = join(tmpdir(), 'hangar-first-run-report.json')
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`\nSummary:`)
for (const r of results) console.log(`  ${r.pass === null ? '??  ' : r.pass ? 'PASS' : 'FAIL'}  ${r.check}`)
console.log(`Report: ${out}`)
process.exit(0)
}

void main()
