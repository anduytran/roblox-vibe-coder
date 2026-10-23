import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AppSettings, Review } from '../src/shared/types'
import { AgentRunner, type QueryFn } from '../src/main/agentRunner'
import { Autopilot, autoMergeBlocker, type TaskOutcome } from '../src/main/autopilot'
import { CostTracker } from '../src/main/costs'
import { ProjectRegistry } from '../src/main/projects'
import { ReviewActions } from '../src/main/reviewActions'
import { ReviewPipeline } from '../src/main/reviewPipeline'
import { ReviewStore } from '../src/main/reviews'
import { listRoles } from '../src/main/roles'
import { createGameProject, projectFolderName, sanitizeNewGame } from '../src/main/scaffold'
import { fetchDiscovery, parseIdeas, robloxGet, scoreGames, scoreGenres, spaceSaturation, Trends, type JsonGet } from '../src/main/trending'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick()
  }
}

const input = (parentDir: string, extra: Record<string, unknown> = {}) =>
  sanitizeNewGame({
    name: 'Sky Courier!',
    parentDir,
    idea: 'Deliver parcels between floating islands with a glider. Upgrades, weather, co-op.',
    document: { name: 'design.md', text: '# Design\nIslands drift; storms block routes.' },
    platforms: ['phone', 'pc', 'toaster'],
    genre: 'Delivery / Simulator',
    notes: 'Keep sessions under 15 minutes.',
    model: 'claude-sonnet-5-5',
    dailyBudgetUsd: 15,
    studioTools: true,
    autopilot: { sprintTasks: 99, sprintBudgetUsd: 0.01, autoMerge: true },
    startNow: true,
    ...extra
  })

// ---------- new game ----------

test('new game: creates a ready-to-build Rojo project with the brief, roles, vaults and a first commit', async () => {
  const parent = tmp('hangar-new-')
  const i = input(parent)
  assert.deepEqual(i.platforms, ['phone', 'pc'], 'unknown platforms dropped')
  assert.equal(i.autopilot.sprintTasks, 20, 'clamped')
  assert.equal(i.autopilot.sprintBudgetUsd, 0.5, 'clamped')
  const root = await createGameProject(i)
  assert.equal(root, join(parent, projectFolderName('Sky Courier!')))
  for (const f of ['default.project.json', 'src/server/main.server.luau', 'src/client/main.client.luau', 'src/shared/Config.luau', 'selene.toml', 'stylua.toml', '.gitignore', 'CLAUDE.md', 'design-vault/Brief.md', 'design-vault/Game Overview.md', 'ui-vault/Style Guide.md']) {
    assert.ok(existsSync(join(root, f)), f)
  }
  const brief = readFileSync(join(root, 'design-vault', 'Brief.md'), 'utf8')
  assert.match(brief, /floating islands/)
  assert.match(brief, /Phone and tablet/)
  assert.match(brief, /Attached document: design\.md[\s\S]*storms block routes/)
  assert.ok(listRoles(root).some((r) => r.id === 'lead' && r.vaultKind === 'design'))
  const project = JSON.parse(readFileSync(join(root, 'default.project.json'), 'utf8'))
  assert.equal(project.tree.ServerScriptService.Server.$path, 'src/server')
  assert.match(readFileSync(join(root, 'src/shared/Config.luau'), 'utf8'), /GAME_NAME = "Sky Courier!"/)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root }).toString().trim()
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(g('status', '--porcelain'), '', 'everything committed')
  assert.match(g('log', '-1', '--format=%s'), /New game: Sky Courier!/)
  // A non-empty target folder is refused.
  await assert.rejects(createGameProject(i), /already exists/)
  await assert.rejects(createGameProject({ ...i, name: 'Other', idea: '', document: null }), /Describe the game idea/)
  // Code-breaking names can't escape the Luau string.
  const odd = await createGameProject({ ...input(tmp('hangar-new2-')), name: 'Bad"]] os.exit() --' })
  assert.doesNotMatch(readFileSync(join(odd, 'src/shared/Config.luau'), 'utf8'), /"\]\]/)
})

// ---------- trends ----------

function fakeRoblox(): { get: JsonGet; urls: string[] } {
  const now = Date.now()
  const iso = (daysAgo: number) => new Date(now - daysAgo * 864e5).toISOString()
  const game = (id: number, name: string, genre: string, players: number, up = 900, down = 100) => ({ universeId: id, rootPlaceId: id * 10, name, playerCount: players, totalUpVotes: up, totalDownVotes: down, isSponsored: false, genreL1: genre })
  // Six tower-defense games crowd that space (one giant); one fresh obby-like game sits alone in its space.
  const td = [1, 2, 3, 4, 5, 6].map((i) => game(i, `Tower Game ${i}`, 'Strategy', i === 1 ? 200_000 : 8000))
  const sorts = {
    sorts: [
      { sortId: 'filters_v5', games: [] },
      { sortId: 'top-trending', games: [game(10, 'Cloud Parkour', 'Obby & Platformer', 9000), ...td, { ...game(99, 'Ad', 'Strategy', 1), isSponsored: true }] },
      { sortId: 'up-and-coming', games: [game(10, 'Cloud Parkour', 'Obby & Platformer', 9000), game(20, 'Fish Tycoon\u202e', 'Tycoon', 4000)] },
      { sortId: 'top-playing-now', games: td.slice(0, 2) }
    ]
  }
  const details: Record<number, unknown> = {
    10: { id: 10, description: 'Jump between clouds', visits: 1e6, favoritedCount: 5e4, created: iso(20), updated: iso(2), genre_l1: 'Obby & Platformer', genre_l2: 'Obby' },
    20: { id: 20, description: 'Catch fish, build a shop', visits: 2e5, favoritedCount: 1e4, created: iso(10), updated: iso(1), genre_l1: 'Tycoon', genre_l2: 'Tycoon' }
  }
  for (const t of td) details[t.universeId] = { id: t.universeId, description: 'Defend', visits: 1e8, favoritedCount: 1e6, created: iso(900), updated: iso(30), genre_l1: 'Strategy', genre_l2: 'Tower Defense' }
  const urls: string[] = []
  const get: JsonGet = async (url) => {
    urls.push(url)
    if (url.includes('get-sorts')) return sorts
    const ids = new URL(url).searchParams.get('universeIds')!.split(',').map(Number)
    return { data: ids.map((id) => details[id]).filter(Boolean) }
  }
  return { get, urls }
}

test('trends: scores from the discovery lists, and crowded game spaces rank lower', async () => {
  const { get, urls } = fakeRoblox()
  const d = await fetchDiscovery(get)
  assert.ok(urls[0]!.startsWith('https://apis.roblox.com/explore-api/v1/get-sorts?sessionId='))
  assert.ok(!d.lists['top-trending']!.some((g) => g.name === 'Ad'), 'sponsored entries skipped')
  const games = scoreGames(d, [])
  const cloud = games.find((g) => g.name === 'Cloud Parkour')!
  const giant = games.find((g) => g.name === 'Tower Game 1')!
  assert.equal(cloud.genre, 'Obby')
  assert.equal(giant.genre, 'Tower Defense')
  assert.ok(giant.parts.saturation > 60, `tower defense is crowded (${giant.parts.saturation})`)
  assert.ok(cloud.parts.saturation < 25, `obby space is open here (${cloud.parts.saturation})`)
  assert.ok(giant.score < giant.demand, 'saturation reduces the score')
  assert.equal(cloud.score, Math.round(cloud.demand * (1 - 0.4 * (cloud.parts.saturation / 100))) || cloud.score)
  assert.equal(games[0]!.name, 'Cloud Parkour', 'a fresh game in an open space beats a giant in a crowded one')
  assert.doesNotMatch(games.find((g) => g.universeId === 20)!.name, /\u202e/, 'hidden characters stripped')
  for (let i = 1; i < games.length; i++) assert.ok(games[i - 1]!.score >= games[i]!.score, 'sorted by score')

  const genres = scoreGenres(games)
  const tdSpace = genres.find((g) => g.genre === 'Tower Defense')!
  assert.equal(tdSpace.games, 6)
  assert.equal(tdSpace.leader, 'Tower Game 1')
  assert.ok(tdSpace.score < tdSpace.demand)
  const sat = spaceSaturation([{ genre: 'A', players: 10, createdAt: null, name: 'x' }])
  assert.ok(sat.get('A')!.saturation < 0.2, 'a single game is not a saturated space')
})

test('trends: momentum comes from player-count history; refresh keeps snapshots and reports errors', async () => {
  const { get } = fakeRoblox()
  const d = await fetchDiscovery(get)
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const rising = scoreGames(d, [{ at: dayAgo, players: { '20': 1000 } }]).find((g) => g.universeId === 20)!
  const falling = scoreGames(d, [{ at: dayAgo, players: { '20': 40000 } }]).find((g) => g.universeId === 20)!
  assert.ok(rising.growth! > 2)
  assert.ok(rising.parts.momentum > 90 && falling.parts.momentum < 10)

  let t = Date.now()
  const trends = new Trends(join(tmp('hangar-trends-'), 'trends.json'), { get, now: () => t })
  const snap = await trends.refresh()
  assert.ok(snap.games.length > 5 && snap.genres.length > 2 && snap.error === null)
  t += 2 * 3600 * 1000
  await trends.refresh()
  const broken = new Trends(join(tmp('hangar-trends2-'), 'trends.json'), { get: async () => { throw new Error('offline') } })
  assert.match((await broken.refresh()).error ?? '', /offline/)
  await assert.rejects(robloxGet('https://evil.example/x'), /not allowed/)
  await assert.rejects(robloxGet('http://apis.roblox.com/x'), /not allowed/)
})

test('trends: AI ideas are scored by the demand they ride and the saturation of their space', async () => {
  const { get } = fakeRoblox()
  const games = scoreGames(await fetchDiscovery(get), [])
  const genres = scoreGenres(games)
  const raw = '```json\n' + JSON.stringify([
    { title: 'Tower Rush', pitch: 'Another tower defense.', coreLoop: 'Place, upgrade, defend', whyNow: 'TD is big', genre: 'Tower Defense', scope: 'medium', inspiredBy: ['Tower Game 1'] },
    { title: 'Cloud Couriers', pitch: 'Parkour deliveries across clouds.', coreLoop: 'Grab, run, deliver', whyNow: 'Open obby space', genre: 'Obby', scope: 'small', inspiredBy: ['Cloud Parkour'] },
    { title: '', pitch: 'no title' }
  ]) + '\n```'
  const ideas = parseIdeas(raw, games, genres)
  assert.equal(ideas.length, 2)
  assert.equal(ideas[0]!.title, 'Cloud Couriers', 'the open space ranks first')
  assert.ok(ideas[1]!.score < games.find((g) => g.name === 'Tower Game 1')!.demand)
  assert.deepEqual(parseIdeas('nope', games, genres), [])

  // The idea call has no tools and never holds the real key.
  let seen: Record<string, unknown> | null = null
  const query: QueryFn = ({ options }) =>
    (async function* () {
      seen = options
      yield { type: 'assistant', message: { content: [{ type: 'text', text: raw }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.02 }
    })()
  const auth: unknown[] = []
  const costs = new CostTracker(join(tmp('hangar-ideas-c-'), 'c.json'))
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const trends = new Trends(join(tmp('hangar-ideas-'), 't.json'), { get, loadQuery: async () => query, getApiKey: () => 'k', getSettings: () => settings, engineAuth: async (_k, o) => (auth.push(o), { env: {}, release: () => {} }), costs })
  const snap = await trends.generateIdeas()
  assert.equal(snap.ideas[0]!.title, 'Cloud Couriers')
  assert.deepEqual(auth, [{ forceHideKey: true }])
  assert.deepEqual(seen!.mcpServers, {})
  for (const tool of ['Bash', 'Read', 'Write', 'WebFetch']) assert.ok((seen!.disallowedTools as string[]).includes(tool))
  assert.equal(costs.summary().todayUsd, 0.02)
})

test('idea chat: replies see the trends and the whole conversation, with no tools; a brief becomes an idea', async () => {
  const { get } = fakeRoblox()
  const prompts: string[] = []
  const options: Record<string, unknown>[] = []
  let reply = 'What do you enjoy playing?'
  let gate: Promise<void> = Promise.resolve()
  const query: QueryFn = ({ prompt, options: o }) =>
    (async function* () {
      prompts.push(prompt)
      options.push(o)
      await gate
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const auth: unknown[] = []
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const file = join(tmp('hangar-chat-'), 't.json')
  const trends = new Trends(file, { get, loadQuery: async () => query, getApiKey: () => 'k', getSettings: () => settings, engineAuth: async (_k, o) => (auth.push(o), { env: {}, release: () => {} }) })

  let chat = await trends.sendChat('  I like obbies  ')
  assert.deepEqual(chat.map((m) => [m.role, m.text]), [['user', 'I like obbies'], ['assistant', 'What do you enjoy playing?']])
  assert.match(prompts[0]!, /Trending on Roblox/)
  assert.match(prompts[0]!, /Cloud Parkour/)
  assert.deepEqual(auth, [{ forceHideKey: true }])
  assert.deepEqual(options[0]!.mcpServers, {})
  for (const tool of ['Bash', 'Read', 'Write', 'WebFetch']) assert.ok((options[0]!.disallowedTools as string[]).includes(tool))
  assert.equal(options[0]!.resume, undefined, 'each reply is a fresh run')

  reply = 'Cloud Couriers fits.\n```json\n' + JSON.stringify([{ title: 'Cloud Couriers', pitch: 'Parkour deliveries.', coreLoop: 'Grab, run, deliver', whyNow: 'Open obby space', genre: 'Obby', scope: 'small', inspiredBy: ['Cloud Parkour'] }]) + '\n```'
  chat = await trends.sendChat('Make it a brief')
  assert.match(prompts[1]!, /User: I like obbies[\s\S]*You: What do you enjoy playing\?[\s\S]*User: Make it a brief/)
  const last = chat[chat.length - 1]!
  assert.equal(last.text, 'Cloud Couriers fits.', 'the JSON block is not shown as text')
  assert.equal(last.idea?.title, 'Cloud Couriers')

  // Kept across restarts; one message at a time; start over clears it.
  assert.equal(new Trends(file).chat().length, 4)
  let open!: () => void
  gate = new Promise((r) => (open = r))
  const first = trends.sendChat('one')
  await assert.rejects(trends.sendChat('two'), /still answering/)
  open()
  await first
  assert.deepEqual(trends.clearChat(), [])
  assert.deepEqual(await trends.sendChat('   '), [])
})

test('refine: an idea is rewritten in place as asked, with no tools, and can be undone', async () => {
  const { get } = fakeRoblox()
  const brief = (title: string, genre: string) => '```json\n' + JSON.stringify([{ title, pitch: `${title} pitch.`, coreLoop: 'Loop', whyNow: 'Now', genre, scope: 'small', inspiredBy: ['Cloud Parkour'] }]) + '\n```'
  let reply = '```json\n' + JSON.stringify([
    { title: 'Cloud Couriers', pitch: 'Parkour deliveries.', coreLoop: 'Grab, run, deliver', whyNow: 'Open obby space', genre: 'Obby', scope: 'small', inspiredBy: ['Cloud Parkour'] },
    { title: 'Tower Rush', pitch: 'Tower defense.', coreLoop: 'Place, defend', whyNow: 'TD', genre: 'Tower Defense', scope: 'medium', inspiredBy: ['Tower Game 1'] }
  ]) + '\n```'
  const prompts: string[] = []
  const options: Record<string, unknown>[] = []
  const query: QueryFn = ({ prompt, options: o }) =>
    (async function* () {
      prompts.push(prompt)
      options.push(o)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const trends = new Trends(join(tmp('hangar-refine-'), 't.json'), { get, loadQuery: async () => query, getApiKey: () => 'k', getSettings: () => settings, engineAuth: async () => ({ env: {}, release: () => {} }) })
  const ideas = (await trends.generateIdeas()).ideas
  const target = ideas.find((i) => i.title === 'Tower Rush')!

  reply = brief('Tower Rush Co-op', 'Tower Defense')
  const after = await trends.refineIdea(target.id, '  make it co-op  ')
  assert.match(prompts[1]!, /Current concept:[\s\S]*Tower Rush[\s\S]*The user's request: make it co-op$/)
  assert.ok(!/"score"|"id"/.test(prompts[1]!), 'only the concept is sent')
  for (const tool of ['Bash', 'Read', 'Write', 'WebFetch']) assert.ok((options[1]!.disallowedTools as string[]).includes(tool))
  assert.deepEqual(after.ideas.map((i) => i.id), ideas.map((i) => i.id), 'same ideas, same order')
  const refined = after.ideas.find((i) => i.id === target.id)!
  assert.equal(refined.title, 'Tower Rush Co-op')
  assert.equal(refined.previous?.title, 'Tower Rush')

  const undone = trends.undoRefine(target.id).ideas.find((i) => i.id === target.id)!
  assert.equal(undone.title, 'Tower Rush')
  assert.equal(undone.previous, undefined)

  await assert.rejects(trends.refineIdea(target.id, '   '), /how to change/)
  await assert.rejects(trends.refineIdea('missing', 'x'), /no longer here/)
  reply = 'not json'
  await assert.rejects(trends.refineIdea(target.id, 'x'), /expected format/)
})

test('ideas: kinds steer the prompt, ideas start short, details come on request, and saved ideas stay', async () => {
  const { get } = fakeRoblox()
  const short = '```json\n' + JSON.stringify([
    { title: 'Moon Mail', pitch: 'Deliver letters on a low-gravity moon.', genre: 'Obby', scope: 'small', inspiredBy: [] },
    { title: 'Echo Keep', pitch: 'A castle that remembers your moves.', genre: 'Puzzle', scope: 'medium', inspiredBy: [] }
  ]) + '\n```'
  let reply = short
  const prompts: { system: string; prompt: string }[] = []
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      prompts.push({ system: String(options.systemPrompt), prompt })
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
    })()
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const file = join(tmp('hangar-kinds-'), 't.json')
  const trends = new Trends(file, { get, loadQuery: async () => query, getApiKey: () => 'k', getSettings: () => settings, engineAuth: async () => ({ env: {}, release: () => {} }) })

  // Original ideas don't build on specific games: the prompt has the game spaces, not the game list.
  const first = await trends.generateIdeas('original')
  assert.match(prompts[0]!.system, /NOT versions of any trending game/)
  assert.ok(!/Trending on Roblox/.test(prompts[0]!.prompt) && /Game spaces/.test(prompts[0]!.prompt))
  assert.ok(first.ideas.every((i) => i.category === 'original' && !i.detailed && i.coreLoop === ''))
  await trends.generateIdeas('trend')
  assert.match(prompts[1]!.prompt, /Trending on Roblox/)

  // Save one, then get new ideas: the saved one stays (and survives a restart).
  const keep = trends.current().ideas[0]!
  trends.saveIdea(keep.id)
  trends.saveIdea(keep.id)
  await trends.generateIdeas('niche')
  assert.equal(trends.current().saved.length, 1)
  assert.ok(!trends.current().ideas.some((i) => i.id === keep.id))
  assert.equal(new Trends(file).current().saved[0]?.title, keep.title)

  // Asking anything of a short saved idea fills in its details.
  reply = '```json\n' + JSON.stringify([{ title: keep.title, pitch: keep.pitch, coreLoop: 'Run, sort, deliver', whyNow: 'Open space', features: ['Low gravity jumps', 'Mail sorting'], firstVersion: 'One district.', genre: 'Obby', scope: 'small', inspiredBy: [] }]) + '\n```'
  const expanded = (await trends.refineIdea(keep.id, 'Fill in the full details.')).saved[0]!
  assert.equal(expanded.id, keep.id)
  assert.equal(expanded.detailed, true)
  assert.deepEqual(expanded.features, ['Low gravity jumps', 'Mail sorting'])
  assert.equal(expanded.firstVersion, 'One district.')
  assert.equal(expanded.category, keep.category, 'keeps its kind')
  assert.equal(trends.undoRefine(keep.id).saved[0]!.detailed, undefined)

  // A brief from the chat can be saved too; unsaving removes it.
  reply = 'Try this.\n' + short
  const chat = await trends.sendChat('something original', 'original')
  assert.match(prompts[prompts.length - 1]!.system, /NOT versions of any trending game/)
  const brief = chat[chat.length - 1]!.idea!
  assert.equal(brief.category, 'original')
  assert.equal(trends.saveIdea(brief.id).saved[0]!.id, brief.id)
  assert.equal(trends.unsaveIdea(brief.id).saved.some((i) => i.id === brief.id), false)
  assert.throws(() => trends.saveIdea('nope'), /no longer here/)
})

// ---------- autopilot (unit) ----------

function autopilotSetup() {
  const dir = tmp('hangar-ap-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'x'), 'x')
  const registry = new ProjectRegistry(join(tmp('hangar-ap-r-'), 'p.json'))
  const project = registry.add(dir)
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'agents', 'lead.md'), '---\nname: Lead\ndescription: d\n---\nLead.')
  const reviews = new ReviewStore(join(tmp('hangar-ap-rv-'), 'r.json'))
  const costs = new CostTracker(join(tmp('hangar-ap-c-'), 'c.json'))
  const sent: { agentId: string; prompt: string; origin: unknown }[] = []
  const merged: string[] = []
  const events: AgentEvent[] = []
  const file = join(tmp('hangar-ap-s-'), 'autopilot.json')
  let ap!: Autopilot
  const make = () =>
    (ap = new Autopilot({
      file,
      registry,
      reviews,
      costs,
      emit: (e) => events.push(e),
      send: (_p, agentId, prompt, opts) => sent.push({ agentId, prompt, origin: opts.origin }),
      merge: async (id) => {
        merged.push(id)
        const r = reviews.update(id, { status: 'merged' })
        ap.onReview(r)
        return r
      }
    }))
  make()
  const review = (fields: Partial<Review> = {}): Review =>
    reviews.add({ projectId: project.id, agentId: 'lead', title: 'Glider controls', branch: 'hangar/x', base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'Built glider', files: ['a.luau'], incomplete: null, note: null, ...fields })
  const done = (o: Partial<TaskOutcome>) => ap.onTaskDone({ projectId: project.id, agentId: 'lead', task: { id: 't', prompt: sent.at(-1)!.prompt, createdAt: 0, origin: sent.at(-1)!.origin as never }, ok: true, stopped: false, text: 'Built the glider.\nTested.', error: null, reviewId: null, ...o })
  return { registry, project, reviews, costs, sent, merged, events, review, done, ap: () => ap, restart: make }
}

const green = { checks: { status: 'done' as const, reason: null, results: [{ name: 'Lint', command: 'selene src', status: 'passed' as const, output: '', ms: 1 }] }, aiReview: { status: 'done' as const, verdict: 'approve' as const, summary: 'ok', findings: [], costUsd: 0, error: null } }

test('autopilot: sprint loop — green work merges itself, the sprint ends with a check-in, feedback starts the next', async () => {
  const t = autopilotSetup()
  assert.throws(() => t.ap().start(t.project.id), /Autonomous mode/)
  t.registry.update(t.project.id, { settings: { autonomous: true } })
  t.ap().configure(t.project.id, { sprintTasks: 2, sprintBudgetUsd: 100 })
  t.ap().start(t.project.id)
  assert.equal(t.sent[0]!.agentId, 'lead')
  assert.equal(t.sent[0]!.origin, 'autopilot')
  assert.match(t.sent[0]!.prompt, /Brief\.md/, 'the first task kicks off from the brief')

  // Task 1: a review that passes checks and the reviewer → merged automatically, task 2 queued.
  const r1 = t.review(green)
  t.done({ reviewId: r1.id })
  await until(() => t.merged.includes(r1.id) && t.sent.length === 2)
  assert.match(t.sent[1]!.prompt, /task 2 of 2/)
  assert.match(t.sent[1]!.prompt, /Glider controls \(merged\)/)

  // Task 2: reviewer has concerns → autopilot waits for you; your merge lets it carry on.
  const r2 = t.review({ ...green, title: 'Weather', aiReview: { ...green.aiReview, verdict: 'concerns' } })
  t.done({ reviewId: r2.id })
  assert.equal(t.ap().get(t.project.id).status, 'waiting')
  assert.match(t.ap().get(t.project.id).reason ?? '', /Weather.*needs your review.*concerns/)
  assert.equal(t.merged.length, 1)
  t.ap().onReview(t.reviews.update(r2.id, { status: 'merged' }))
  // Sprint used up → the check-in report is requested.
  assert.equal(t.sent.at(-1)!.origin, 'autopilot-report')
  assert.match(t.sent.at(-1)!.prompt, /Glider controls: merged\n- Weather: merged/)
  t.done({ text: '## Built\nGlider and weather.\n## Questions for you\nCo-op now?' })
  const st = t.ap().get(t.project.id)
  assert.equal(st.status, 'checkin')
  assert.match(st.reports.at(-1)!.text, /Co-op now\?/)
  assert.deepEqual(st.reports.at(-1)!.tasks.map((x) => x.outcome), ['merged', 'merged'])

  // You answer and start sprint 2: the feedback goes to the Lead.
  t.ap().start(t.project.id, { feedback: 'Yes, add co-op next. Make storms rarer.' })
  const s2 = t.ap().get(t.project.id)
  assert.equal(s2.sprint, 2)
  assert.equal(s2.status, 'running')
  assert.match(t.sent.at(-1)!.prompt, /sprint 2, task 1[\s\S]*add co-op next/)
  assert.deepEqual(t.ap().get(t.project.id).feedback, [], 'feedback handed over once')
})

test('autopilot: pauses on stops, repeated failures, unmergeable work with auto-merge off, and restarts', async () => {
  const t = autopilotSetup()
  t.registry.update(t.project.id, { settings: { autonomous: true } })
  t.ap().configure(t.project.id, { sprintTasks: 5, autoMerge: false })
  t.ap().start(t.project.id)
  const r = t.review(green)
  t.done({ reviewId: r.id })
  assert.equal(t.ap().get(t.project.id).status, 'waiting', 'auto-merge off: even green work waits')
  assert.match(t.ap().get(t.project.id).reason ?? '', /Auto-merge is off/)
  t.ap().onReview(t.reviews.update(r.id, { status: 'discarded' }))
  assert.equal(t.ap().get(t.project.id).status, 'running')
  assert.equal(t.ap().get(t.project.id).sprintTasks.at(-1)!.outcome, 'discarded')

  t.done({ ok: false, error: 'boom' })
  assert.equal(t.ap().get(t.project.id).status, 'running', 'one failure: carry on')
  t.done({ ok: false, error: 'boom again' })
  assert.equal(t.ap().get(t.project.id).status, 'paused')
  assert.match(t.ap().get(t.project.id).reason ?? '', /Two tasks in a row failed.*boom again/)
  const before = t.sent.length
  t.ap().resume(t.project.id)
  assert.equal(t.sent.length, before + 1, 'resume queues the next task')
  t.done({ ok: false, stopped: true })
  assert.match(t.ap().get(t.project.id).reason ?? '', /stopped/)

  t.ap().resume(t.project.id)
  t.restart()
  assert.equal(t.ap().get(t.project.id).status, 'paused')
  assert.match(t.ap().get(t.project.id).reason ?? '', /Hangar was closed/)
})

test('autopilot: what can merge on its own', () => {
  const base = { id: 'r', projectId: 'p', agentId: 'lead', title: 't', branch: 'b', base: 'main', baseSha: '', headSha: '', summary: '', files: [], status: 'pending', incomplete: null, note: null, createdAt: 0, clip: null, published: null } as Review
  assert.equal(autoMergeBlocker({ ...base, ...green }), null)
  assert.match(autoMergeBlocker({ ...base, ...green, note: 'Hangar moved 3 ignored files' })!, /ignored/)
  assert.match(autoMergeBlocker({ ...base, ...green, incomplete: 'stopped' })!, /stopped/)
  assert.match(autoMergeBlocker({ ...base, ...green, checks: { ...green.checks, status: 'skipped', reason: 'rokit.toml changed' } })!, /Checks didn't run/)
  assert.match(autoMergeBlocker({ ...base, ...green, aiReview: { ...green.aiReview, verdict: 'block' } })!, /reviewer/)
  assert.match(autoMergeBlocker(base)!, /nothing to approve it/)
  assert.match(autoMergeBlocker({ ...base, kind: 'research' })!, /Research/)
  for (const f of ['package.json', '.github/workflows/x.yml', 'eslint.config.js', 'tools/run.ps1', '.mcp.json', 'node_modules/x/index.js']) {
    assert.match(autoMergeBlocker({ ...base, ...green, files: ['src/a.luau', f] }) ?? '', /control how code or tools run/, f)
  }
})

// ---------- autopilot (end to end with the real runner, git and pipeline) ----------

test('autopilot end to end: tasks run on branches, approved work lands on main, then the check-in', async () => {
  const root = await createGameProject(input(tmp('hangar-e2e-'), { autopilot: { sprintTasks: 2, sprintBudgetUsd: 50, autoMerge: true } }))
  const registry = new ProjectRegistry(join(tmp('hangar-e2e-r-'), 'p.json'))
  const project = registry.update(registry.add(root).id, { settings: { autonomous: true, reviewer: true, checks: [], sandbox: false } })
  const reviews = new ReviewStore(join(tmp('hangar-e2e-rv-'), 'r.json'))
  const costs = new CostTracker(join(tmp('hangar-e2e-c-'), 'c.json'))
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 2, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: false, rojoCommand: 'rojo', authMode: 'apiKey', planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  let n = 0
  const query: QueryFn = ({ prompt, options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] }
      if (!prompt.includes('check-in')) {
        n++
        writeFileSync(join(options.cwd as string, 'src', 'server', `Feature${n}.luau`), `return ${n}\n`)
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `Feature ${n}: built and playtested.` }] } }
      } else {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '## Built\nTwo features.\n## Questions for you\nNone.' }] } }
      }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.1 }
    })()
  let pipeline!: ReviewPipeline
  let autopilot!: Autopilot
  let actions!: ReviewActions
  const emit = (e: AgentEvent) => {
    if (e.type === 'approval' && e.request.toolName === 'Project setup') queueMicrotask(() => runner.respond(e.request.id, 'allow'))
    if (e.type === 'review') autopilot?.onReview(e.review)
  }
  const runner: AgentRunner = new AgentRunner({
    registry,
    costs,
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test-key-123456',
    engineAuth: async (k) => ({ env: { ANTHROPIC_API_KEY: k }, release: () => {} }),
    loadQuery: async () => query,
    emit,
    persistFile: join(tmp('hangar-e2e-p-'), 'a.json'),
    trustFile: join(tmp('hangar-e2e-t-'), 't.json'),
    appDataDir: tmp('hangar-e2e-data-'),
    platform: 'linux',
    reviews,
    onReview: (r) => void pipeline.start(r),
    onTaskDone: (o) => autopilot.onTaskDone(o)
  })
  const reviewer = { review: async () => ({ status: 'done' as const, verdict: 'approve' as const, summary: 'Looks fine.', findings: [], costUsd: 0, error: null }) }
  pipeline = new ReviewPipeline({ registry, reviews, emit, runChecks: async () => null, reviewer })
  actions = new ReviewActions({ registry, reviews, runner, emit, publisher: null, pipeline })
  autopilot = new Autopilot({ file: join(tmp('hangar-e2e-a-'), 'ap.json'), registry, reviews, costs, emit, send: (p, a, prompt, o) => runner.send(p, a, prompt, o), merge: (id) => actions.merge(id) })
  autopilot.configure(project.id, { sprintTasks: 2, sprintBudgetUsd: 50, autoMerge: true })
  autopilot.start(project.id)
  await until(() => autopilot.get(project.id).status === 'checkin', 15000)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root }).toString().trim()
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'main')
  assert.ok(existsSync(join(root, 'src', 'server', 'Feature1.luau')) && existsSync(join(root, 'src', 'server', 'Feature2.luau')), 'both features on main')
  assert.deepEqual(reviews.list().map((r) => r.status), ['merged', 'merged'])
  assert.match(reviews.list().at(-1)!.title, /Feature 1: built and playtested/, 'readable review titles')
  const st = autopilot.get(project.id)
  assert.match(st.reports.at(-1)!.text, /Two features/)
  assert.equal(g('branch', '--list', 'hangar/*'), '', 'task branches cleaned up')
})
