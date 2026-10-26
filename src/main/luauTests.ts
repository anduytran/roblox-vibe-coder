import { request } from 'node:https'
import type { LuauTestSettings, ProjectSettings } from '@shared/types'
import { revealHidden } from '@shared/text'

/**
 * Luau tests: checks that verify game code without Roblox Studio open, so autopilot can merge work it has
 * actually tested while you're away.
 *
 * Tests are `*.spec.luau` files that return a table of test functions; a test fails when it errors (assert).
 * Two runners, each turned on in the Project tab:
 *
 * - Lune (local): every `*.spec.luau` except `*.cloud.spec.luau` runs with Lune on your computer, inside the
 *   OS sandbox (no network, writes only to the temporary checkout). For game logic that doesn't need the
 *   engine: damage formulas, inventories, round state. Needs the sandbox, so it doesn't run on Windows.
 * - Test place (Roblox Open Cloud): Hangar builds the branch with Rojo, uploads it to the project's test
 *   place as a saved (not published) version, and runs a fixed smoke script in a fresh Roblox server of that
 *   version: every ModuleScript must load without errors, then every `.spec` ModuleScript's tests run, with
 *   the real engine. The Open Cloud key never leaves Hangar's main process; the game code runs on Roblox's
 *   servers, not your computer.
 *
 * Results are ordinary check results on the review, so Merge and autopilot's auto-merge treat them like
 * any other check. They're a quality gate, not a security boundary: tests are written by agents, and code
 * that is being tested can fake its own results.
 */

export const DEFAULT_LUAU_TESTS: LuauTestSettings = { lune: false, testPlace: false }

export function cleanLuauTests(v: unknown): LuauTestSettings {
  const o = v && typeof v === 'object' ? (v as Partial<LuauTestSettings>) : {}
  return { lune: o.lune === true, testPlace: o.testPlace === true }
}

/** True when any check (commands or Luau tests) is set up for this project. */
export function hasChecks(s: ProjectSettings): boolean {
  const t = cleanLuauTests(s.luauTests)
  return s.checks.length > 0 || t.lune || t.testPlace
}

export const LUNE_CHECK_NAME = 'Luau tests (Lune)'
export const CLOUD_CHECK_NAME = 'Luau tests (test place)'

/** Where Hangar writes its Lune runner in the temporary checkout (overwriting any file the branch has there). */
export const LUNE_RUNNER_FILE = 'hangar-run-tests.luau'

/** Hangar's own Lune runner. Specs are required relative to the checkout root, where this file sits. */
export const LUNE_RUNNER = `-- Hangar's test runner for Lune. Hangar writes it into a temporary checkout; it isn't part of your game.
local fs = require("@lune/fs")
local process = require("@lune/process")

local SKIP = { node_modules = true, Packages = true, DevPackages = true, ServerPackages = true }
local specs = {}
local function walk(dir)
	for _, name in fs.readDir(dir) do
		local path = if dir == "." then name else dir .. "/" .. name
		if fs.isDir(path) then
			if not SKIP[name] and name:sub(1, 1) ~= "." then
				walk(path)
			end
		elseif name:match("%.spec%.luau$") and not name:match("%.cloud%.spec%.luau$") then
			table.insert(specs, path)
		end
	end
end
walk(".")
table.sort(specs)

local passed, failed = 0, 0
local function fail(label, err)
	failed += 1
	print("FAIL " .. label)
	print("    " .. tostring(err):gsub("\\n", "\\n    "))
end

for _, path in specs do
	local ok, suite = pcall(require, "./" .. (path:gsub("%.luau$", "")))
	if not ok then
		fail(path, "couldn't load: " .. tostring(suite))
	elseif type(suite) ~= "table" then
		fail(path, "a spec file must return a table of test functions")
	else
		local keys = {}
		for key, fn in suite do
			if type(fn) == "function" then
				table.insert(keys, key)
			end
		end
		table.sort(keys, function(a, b)
			return tostring(a) < tostring(b)
		end)
		if #keys == 0 then
			fail(path, "no test functions in this file")
		end
		for _, key in keys do
			local label = path .. " > " .. tostring(key)
			local okTest, err = xpcall(suite[key], debug.traceback)
			if okTest then
				passed += 1
				print("PASS " .. label)
			else
				fail(label, err)
			end
		end
	end
end

if #specs == 0 then
	print("No *.spec.luau files found. The QA Tester can write some.")
	process.exit(1)
end
print(string.format("%d passed, %d failed, in %d spec files", passed, failed, #specs))
process.exit(if failed > 0 then 1 else 0)
`

/**
 * Hangar's smoke script, run by Open Cloud in a fresh server of the uploaded place version. It returns a
 * JSON report; Hangar reads it as untrusted data (the game code ran in the same server).
 */
export const CLOUD_SCRIPT = `-- Hangar smoke test: every ModuleScript must load, then every .spec ModuleScript's tests run.
local HttpService = game:GetService("HttpService")
local ROOTS = { "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage" }
local SKIP = { "_Index", "Packages", "DevPackages", "ServerPackages" }
local LIMIT = 10

local function within(fn, ...)
	local args = table.pack(...)
	local finished, ok, value = false, false, nil
	task.spawn(function()
		ok, value = xpcall(function()
			return fn(table.unpack(args, 1, args.n))
		end, debug.traceback)
		finished = true
	end)
	local deadline = os.clock() + LIMIT
	while not finished and os.clock() < deadline do
		task.wait(0.05)
	end
	if not finished then
		return false, "still running after " .. LIMIT .. " seconds"
	end
	return ok, value
end

local function skipped(inst)
	for _, name in SKIP do
		if inst:FindFirstAncestor(name) then
			return true
		end
	end
	return false
end

local report = { modules = 0, loadErrors = {}, tests = {} }
local specs = {}
for _, rootName in ROOTS do
	for _, inst in game:GetService(rootName):GetDescendants() do
		if inst:IsA("ModuleScript") and not skipped(inst) then
			if inst.Name:match("%.spec$") then
				table.insert(specs, inst)
			else
				report.modules += 1
				local ok, err = within(require, inst)
				if not ok then
					table.insert(report.loadErrors, { name = inst:GetFullName(), error = tostring(err) })
				end
			end
		end
	end
end

for _, spec in specs do
	local ok, suite = within(require, spec)
	if not ok then
		table.insert(report.tests, { name = spec:GetFullName(), ok = false, error = "couldn't load: " .. tostring(suite) })
	elseif type(suite) ~= "table" then
		table.insert(report.tests, { name = spec:GetFullName(), ok = false, error = "a spec module must return a table of test functions" })
	else
		local keys = {}
		for key, fn in suite do
			if type(fn) == "function" then
				table.insert(keys, key)
			end
		end
		table.sort(keys, function(a, b)
			return tostring(a) < tostring(b)
		end)
		for _, key in keys do
			local okTest, err = within(suite[key])
			table.insert(report.tests, { name = spec:GetFullName() .. " > " .. tostring(key), ok = okTest, error = if okTest then nil else tostring(err) })
		end
	end
end

return HttpService:JSONEncode(report)
`

const clip = (v: unknown, n: number): string => revealHidden(String(v ?? '')).slice(0, n)

/** Turn the smoke script's JSON report into a check status and readable output. */
export function readCloudReport(results: unknown): { status: 'passed' | 'failed' | 'error'; output: string } {
  const first = Array.isArray(results) ? results[0] : undefined
  let report: { modules?: unknown; loadErrors?: unknown; tests?: unknown } | null = null
  try {
    report = typeof first === 'string' && first.length < 4_000_000 ? JSON.parse(first) : null
  } catch {
    // unreadable: reported below
  }
  if (!report || typeof report !== 'object') return { status: 'error', output: 'The test place returned something Hangar could not read.' }
  const loadErrors = (Array.isArray(report.loadErrors) ? report.loadErrors : []).slice(0, 200) as { name?: unknown; error?: unknown }[]
  // JSON drops an empty table's type, so "no tests" may arrive as {} rather than [].
  const tests = (Array.isArray(report.tests) ? report.tests : []).slice(0, 2000) as { name?: unknown; ok?: unknown; error?: unknown }[]
  const modules = typeof report.modules === 'number' ? report.modules : 0
  const lines: string[] = []
  for (const e of loadErrors) lines.push(`LOAD FAIL ${clip(e?.name, 200)}`, `    ${clip(e?.error, 600).replace(/\n/g, '\n    ')}`)
  let passed = 0
  for (const t of tests) {
    if (t?.ok === true) {
      passed++
      lines.push(`PASS ${clip(t.name, 200)}`)
    } else lines.push(`FAIL ${clip(t?.name, 200)}`, `    ${clip(t?.error, 600).replace(/\n/g, '\n    ')}`)
  }
  const failed = tests.length - passed
  lines.push(
    `${modules - loadErrors.length} of ${modules} modules loaded. ${passed} passed, ${failed} failed${tests.length ? '' : ' (no .spec modules in the place)'}.`
  )
  return { status: loadErrors.length || failed ? 'failed' : 'passed', output: lines.join('\n') }
}

export interface CloudTask {
  path: string
  state: string
  output?: { results?: unknown[] }
  error?: { code?: string; message?: string }
}

/** The Open Cloud calls the test-place check makes. The real one is openCloudApi; tests use a fake. */
export interface CloudApi {
  /** Upload a place file as a saved (unpublished) version of the test place. */
  upload(body: Buffer): Promise<{ versionNumber: number }>
  createTask(versionNumber: number, script: string): Promise<CloudTask>
  getTask(path: string): Promise<CloudTask>
  logs(path: string): Promise<string[]>
}

const TASK_PATH = /^universes\/\d+\/places\/\d+\/versions\/\d+\/luau-execution-sessions\/[\w-]+\/tasks\/[\w-]+$/

function cloudJson(opts: { host: string; method: 'GET' | 'POST'; path: string; apiKey: string; body?: object }): Promise<unknown> {
  return new Promise((resolveCall, reject) => {
    const payload = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null
    const req = request(
      {
        host: opts.host,
        method: opts.method,
        path: opts.path,
        headers: { 'x-api-key': opts.apiKey, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
        timeout: 60_000
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (data.length < 8_000_000) data += c
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              return resolveCall(JSON.parse(data))
            } catch {
              return reject(new Error('Roblox returned an unexpected response.'))
            }
          }
          const hint =
            res.statusCode === 401 || res.statusCode === 403
              ? ' Check the API key has the luau-execution-session Write permission for this game.'
              : res.statusCode === 429
                ? ' Roblox is rate-limiting test runs; try again in a minute.'
                : ''
          reject(new Error(`Roblox refused the test run (HTTP ${res.statusCode}).${hint} ${revealHidden(data.slice(0, 300))}`.trim()))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Roblox did not answer in time.')))
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

export function openCloudApi(opts: {
  universeId: string
  placeId: string
  apiKey: string
  upload: (body: Buffer) => Promise<{ versionNumber: number }>
  host?: string
}): CloudApi {
  const host = opts.host ?? 'apis.roblox.com'
  const base = `/cloud/v2/universes/${encodeURIComponent(opts.universeId)}/places/${encodeURIComponent(opts.placeId)}`
  const checkPath = (p: string): string => {
    if (!TASK_PATH.test(p)) throw new Error('Roblox returned an unexpected task.')
    return p
  }
  const asTask = (v: unknown): CloudTask => {
    const t = (v ?? {}) as CloudTask
    return { path: checkPath(String(t.path ?? '')), state: String(t.state ?? ''), output: t.output, error: t.error }
  }
  return {
    upload: opts.upload,
    createTask: async (version, script) =>
      asTask(await cloudJson({ host, method: 'POST', path: `${base}/versions/${version}/luau-execution-session-tasks`, apiKey: opts.apiKey, body: { script, timeout: '300s' } })),
    getTask: async (path) => asTask(await cloudJson({ host, method: 'GET', path: `/cloud/v2/${checkPath(path)}`, apiKey: opts.apiKey })),
    logs: async (path) => {
      const res = (await cloudJson({ host, method: 'GET', path: `/cloud/v2/${checkPath(path)}/logs?view=FLAT&maxPageSize=100`, apiKey: opts.apiKey })) as {
        luauExecutionSessionTaskLogs?: { messages?: unknown[] }[]
      }
      return (res.luauExecutionSessionTaskLogs ?? []).flatMap((l) => (Array.isArray(l.messages) ? l.messages.map(String) : []))
    }
  }
}

/** Upload the built place, run the smoke script on it and wait for the result. */
export async function runOnTestPlace(
  api: CloudApi,
  place: Buffer,
  opts: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ status: 'passed' | 'failed' | 'error'; output: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? 3000
  const maxWait = opts.maxWaitMs ?? 7 * 60_000
  const { versionNumber } = await api.upload(place)
  let task = await api.createTask(versionNumber, CLOUD_SCRIPT)
  const started = Date.now()
  while (task.state === 'QUEUED' || task.state === 'PROCESSING' || task.state === 'STATE_UNSPECIFIED' || task.state === '') {
    if (Date.now() - started > maxWait) return { status: 'error', output: `Roblox hadn't finished the test run after ${Math.round(maxWait / 60000)} minutes.` }
    await sleep(pollMs)
    task = await api.getTask(task.path)
  }
  if (task.state === 'COMPLETE') {
    const read = readCloudReport(task.output?.results)
    return { ...read, output: `Test place version ${versionNumber}.\n${read.output}` }
  }
  const logs = await api.logs(task.path).catch(() => [] as string[])
  const why = task.state === 'FAILED' ? `The test run failed: ${clip(task.error?.message ?? task.error?.code ?? 'no reason given', 600)}` : `The test run ended: ${clip(task.state, 40)}.`
  // A smoke script that errors or runs out of time means the game code broke it: a failure, not a setup error.
  return { status: task.state === 'FAILED' ? 'failed' : 'error', output: [`Test place version ${versionNumber}.`, why, ...logs.slice(-40).map((l) => clip(l, 400))].join('\n') }
}
