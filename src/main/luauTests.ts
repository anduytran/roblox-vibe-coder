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

/**
 * TestEZ-style specs (describe / it / expect, the format Roblox games usually use), plus the older "table of test
 * functions" format. Shared by both runners; TestEZ itself isn't needed.
 */
export const TESTEZ_SHIM = String.raw`-- TestEZ-style specs (describe / it / expect), without TestEZ itself. newTestEZ() returns the globals a spec
-- uses and a run function that runs the spec's tests in order and returns one result per test.
local ENGINE_MARK = "[needs the game engine]"

local function describeValue(value)
	if type(value) == "string" then
		return string.format("%q", value)
	end
	return tostring(value) .. " (" .. typeof(value) .. ")"
end

local function expect(value)
	local negated = false
	local api
	local function check(pass, message, negatedMessage)
		if negated then
			pass = not pass
			message = negatedMessage
		end
		if not pass then
			error(message, 3)
		end
		return api
	end
	local matchers = {
		ok = function()
			return check(value ~= nil and value ~= false, "Expected value to be truthy, got " .. describeValue(value), "Expected value to be falsy, got " .. describeValue(value))
		end,
		equal = function(other)
			return check(
				value == other,
				"Expected " .. describeValue(other) .. ", got " .. describeValue(value),
				"Expected value not to equal " .. describeValue(other)
			)
		end,
		near = function(other, limit)
			limit = limit or 1e-7
			local pass = type(value) == "number" and type(other) == "number" and math.abs(value - other) <= limit
			return check(
				pass,
				"Expected " .. describeValue(value) .. " to be within " .. tostring(limit) .. " of " .. describeValue(other),
				"Expected " .. describeValue(value) .. " not to be within " .. tostring(limit) .. " of " .. describeValue(other)
			)
		end,
		throw = function(substring)
			local ok, err = pcall(value)
			local pass = not ok
			if pass and substring ~= nil then
				pass = string.find(tostring(err), substring, 1, true) ~= nil
			end
			return check(
				pass,
				if substring then "Expected the function to throw an error containing " .. describeValue(substring) .. (if ok then ", but it didn't throw" else ", got " .. tostring(err)) else "Expected the function to throw",
				"Expected the function not to throw, got " .. tostring(err)
			)
		end,
	}
	matchers.a = function(typeName)
		return check(typeof(value) == typeName, "Expected a " .. tostring(typeName) .. ", got " .. describeValue(value), "Expected not a " .. tostring(typeName))
	end
	matchers.an = matchers.a
	local CHAIN = { to = true, be = true, been = true, have = true, was = true, at = true }
	api = setmetatable({}, {
		__index = function(_, key)
			if key == "never" then
				negated = not negated
				return api
			elseif CHAIN[key] then
				return api
			elseif matchers[key] then
				return matchers[key]
			end
			error("Unknown expectation: " .. tostring(key), 2)
		end,
	})
	return api
end

local function newTestEZ()
	local function newNode(name, parent, skip)
		return { name = name, parent = parent, skip = skip, items = {}, beforeAll = {}, afterAll = {}, beforeEach = {}, afterEach = {} }
	end
	local root = newNode(nil, nil, false)
	local current = root
	local function describe(name, fn, skip)
		local node = newNode(tostring(name), current, skip)
		table.insert(current.items, node)
		local previous = current
		current = node
		local ok, err = pcall(fn)
		current = previous
		if not ok then
			node.err = err
		end
	end
	local function it(name, fn, skip)
		table.insert(current.items, { test = true, name = tostring(name), fn = fn, skip = skip })
	end
	local g = {
		expect = expect,
		describe = function(name, fn)
			describe(name, fn, false)
		end,
		describeSKIP = function(name, fn)
			describe(name, fn, true)
		end,
		it = function(name, fn)
			it(name, fn, false)
		end,
		itSKIP = function(name, fn)
			it(name, fn, true)
		end,
		itFIXME = function(name, fn)
			it(name, fn, true)
		end,
		SKIP = function()
			current.skip = true
		end,
		-- Focus would hide every other test, so focused tests run with the rest.
		FOCUS = function() end,
		HACK_NO_XPCALL = function() end,
	}
	g.describeFOCUS = g.describe
	g.itFOCUS = g.it
	for _, hook in { "beforeAll", "afterAll", "beforeEach", "afterEach" } do
		g[hook] = function(fn)
			table.insert(current[hook], fn)
		end
	end

	-- protect(fn, ...) -> ok, err. Results: { name, status = "passed" | "failed" | "skipped" | "engine", error }.
	local function run(specFn, label, protect)
		local results = {}
		local function add(name, ok, err, skipped)
			local status = if skipped then "skipped" elseif ok then "passed" elseif string.find(tostring(err), ENGINE_MARK, 1, true) then "engine" else "failed"
			table.insert(results, { name = name, status = status, error = if ok then nil else tostring(err) })
		end
		local ok, err = protect(specFn)
		if not ok then
			add(label, false, err)
			return results
		end
		local function walk(node, path, chain, context, skipped)
			if node.err then
				add(path, false, "error in describe block: " .. tostring(node.err))
				return
			end
			skipped = skipped or node.skip
			local blocked
			if not skipped then
				for _, hook in node.beforeAll do
					local okHook, errHook = protect(hook, context)
					if not okHook then
						blocked = "beforeAll failed: " .. tostring(errHook)
						break
					end
				end
			end
			for _, item in node.items do
				local name = path .. " > " .. item.name
				if item.test then
					if skipped or item.skip then
						add(name, true, nil, true)
					elseif blocked then
						add(name, false, blocked)
					else
						local okTest, errTest = true, nil
						for _, n in chain do
							for _, hook in n.beforeEach do
								okTest, errTest = protect(hook, context)
								if not okTest then
									errTest = "beforeEach failed: " .. tostring(errTest)
									break
								end
							end
							if not okTest then
								break
							end
						end
						if okTest then
							okTest, errTest = protect(item.fn, context)
						end
						for i = #chain, 1, -1 do
							for _, hook in chain[i].afterEach do
								local okHook, errHook = protect(hook, context)
								if okTest and not okHook then
									okTest, errTest = false, "afterEach failed: " .. tostring(errHook)
								end
							end
						end
						add(name, okTest, errTest)
					end
				else
					local nextChain = table.clone(chain)
					table.insert(nextChain, item)
					walk(item, name, nextChain, setmetatable({}, { __index = context }), skipped or blocked ~= nil)
				end
			end
			if not skipped and not blocked then
				for _, hook in node.afterAll do
					protect(hook, context)
				end
			end
		end
		walk(root, label, { root }, {}, false)
		if #results == 0 then
			add(label, false, "no tests (it blocks) in this spec")
		end
		return results
	end
	return g, run
end

-- A spec module returns a TestEZ function or a table of test functions.
local function runSpec(value, label, protect, run)
	if type(value) == "function" then
		return run(value, label, protect)
	end
	local results = {}
	if type(value) ~= "table" then
		table.insert(results, { name = label, status = "failed", error = "a spec must return a function (TestEZ style) or a table of test functions" })
		return results
	end
	local keys = {}
	for key, fn in value do
		if type(fn) == "function" then
			table.insert(keys, key)
		end
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, key in keys do
		local ok, err = protect(value[key])
		local status = if ok then "passed" elseif string.find(tostring(err), ENGINE_MARK, 1, true) then "engine" else "failed"
		table.insert(results, { name = label .. " > " .. tostring(key), status = status, error = if ok then nil else tostring(err) })
	end
	if #keys == 0 then
		table.insert(results, { name = label, status = "failed", error = "no test functions in this spec" })
	end
	return results
end
`

/**
 * Hangar's own Lune runner. Game code (specs and the modules they require) runs in an environment Hangar builds:
 * Roblox's data types and a read-only copy of the Rojo project layout (script, game:GetService, require), and none
 * of Lune's own libraries, so tests can't reach files, processes, the network or the Roblox login.
 */
export const LUNE_RUNNER =
  "-- Hangar's test runner for Lune. Hangar writes it into a temporary checkout; it isn't part of your game.\n" +
  TESTEZ_SHIM +
  String.raw`local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local taskLib = require("@lune/task")

local ENGINE = ENGINE_MARK .. " "

-- Game code gets Roblox's data types and a read-only copy of how Rojo lays out the project (so script.Parent,
-- game:GetService and require work), but nothing of Lune's own: no files, processes, network or Roblox login.
-- Anything that needs the real engine (Instance.new, Workspace, Players, RunService...) stops that test with
-- "needs the game engine": those run on the test place instead.
local function needsEngine(what)
	error(ENGINE .. what, 3)
end

local nodeOf = setmetatable({}, { __mode = "k" })
local byFile = {}

local function newNode(name, className, parent)
	return { name = name, className = className, parent = parent, kids = {}, listed = false }
end

local function fullName(n)
	local parts = {}
	while n and n.parent do
		table.insert(parts, 1, n.name)
		n = n.parent
	end
	return if #parts > 0 then table.concat(parts, ".") else (n and n.name or "?")
end

local function moduleFile(dir)
	for _, init in { "init.luau", "init.lua" } do
		if fs.isFile(dir .. "/" .. init) then
			return dir .. "/" .. init
		end
	end
	return nil
end

local function classify(fileName)
	local base, kind = fileName:match("^(.+)%.(server)%.luau?$")
	if not base then
		base, kind = fileName:match("^(.+)%.(client)%.luau?$")
	end
	if base then
		return base, if kind == "server" then "Script" else "LocalScript"
	end
	base = fileName:match("^(.+)%.luau?$")
	if base then
		return base, "ModuleScript"
	end
	return nil
end

local function attachPath(n, path)
	if fs.isDir(path) then
		n.dir = path
		local init = moduleFile(path)
		if init then
			n.file = init
			n.className = "ModuleScript"
			byFile[init] = n
		elseif fs.isFile(path .. "/init.server.luau") or fs.isFile(path .. "/init.client.luau") then
			n.className = "Script"
		end
	elseif fs.isFile(path) then
		local _, className = classify(path:match("[^/]+$"))
		n.className = className or "Folder"
		if className == "ModuleScript" then
			n.file = path
			byFile[path] = n
		end
	end
end

local function list(n)
	if n.listed then
		return n.kids
	end
	n.listed = true
	if n.dir then
		local names = fs.readDir(n.dir)
		table.sort(names)
		for _, entry in names do
			local path = n.dir .. "/" .. entry
			if entry:sub(1, 1) == "." or entry:match("^init%.") then
				continue
			end
			local name, className
			if fs.isDir(path) then
				name, className = entry, "Folder"
			else
				name, className = classify(entry)
			end
			if name and n.kids[name] == nil then
				local kid = newNode(name, className, n)
				attachPath(kid, path)
				n.kids[name] = kid
			end
		end
	end
	return n.kids
end

local function fromTree(name, def, parent)
	local n = newNode(name, def["$className"] or "Folder", parent)
	if type(def["$path"]) == "string" then
		attachPath(n, (def["$path"]:gsub("^%./", ""):gsub("/$", "")))
	end
	for key, value in def do
		if type(key) == "string" and key:sub(1, 1) ~= "$" and type(value) == "table" then
			n.kids[key] = fromTree(key, value, n)
		end
	end
	return n
end

local proxy
local ENGINE_SERVICES = {}

local function childOf(n, name)
	if n.engine then
		needsEngine(fullName(n) .. "." .. tostring(name))
	end
	return list(n)[name]
end

local methods = {
	FindFirstChild = function(n, name)
		local kid = childOf(n, name)
		return kid and proxy(kid)
	end,
	WaitForChild = function(n, name)
		local kid = childOf(n, name)
		if not kid then
			error(string.format("%s is not a child of %s (WaitForChild would wait forever)", tostring(name), fullName(n)), 3)
		end
		return proxy(kid)
	end,
	GetChildren = function(n)
		if n.engine then
			needsEngine(fullName(n) .. ":GetChildren")
		end
		local out = {}
		for _, kid in list(n) do
			table.insert(out, proxy(kid))
		end
		return out
	end,
	IsA = function(n, className)
		return n.className == className
			or className == "Instance"
			or (className == "LuaSourceContainer" and (n.className == "ModuleScript" or n.className == "Script" or n.className == "LocalScript"))
			or (className == "BaseScript" and (n.className == "Script" or n.className == "LocalScript"))
	end,
	GetFullName = function(n)
		return fullName(n)
	end,
	FindFirstAncestor = function(n, name)
		local p = n.parent
		while p do
			if p.name == name then
				return proxy(p)
			end
			p = p.parent
		end
		return nil
	end,
	IsDescendantOf = function(n, other)
		local target = nodeOf[other]
		local p = n.parent
		while p do
			if p == target then
				return true
			end
			p = p.parent
		end
		return false
	end,
}

local game

function proxy(n)
	if n.proxy then
		return n.proxy
	end
	local p = newproxy(true)
	local mt = getmetatable(p)
	mt.__metatable = "The metatable is locked"
	mt.__tostring = function()
		return n.name
	end
	mt.__newindex = function(_, key)
		needsEngine("changing " .. fullName(n) .. "." .. tostring(key))
	end
	mt.__index = function(_, key)
		if key == "Name" then
			return n.name
		elseif key == "ClassName" then
			return n.className
		elseif key == "Parent" then
			return n.parent and proxy(n.parent)
		elseif key == "GetService" and n == game then
			return function(_, name)
				local kid = list(n)[name]
				if kid then
					return proxy(kid)
				end
				if not ENGINE_SERVICES[name] then
					local stub = newNode(tostring(name), tostring(name), n)
					stub.engine = true
					ENGINE_SERVICES[name] = stub
				end
				return proxy(ENGINE_SERVICES[name])
			end
		elseif methods[key] then
			local method = methods[key]
			return function(_, ...)
				return method(n, ...)
			end
		end
		local kid = childOf(n, key)
		if kid then
			return proxy(kid)
		end
		if n == game then
			needsEngine("game." .. tostring(key))
		end
		error(string.format("%s is not a valid member of %s %q", tostring(key), n.className, fullName(n)), 2)
	end
	n.proxy = p
	nodeOf[p] = n
	return p
end

local function engineStub(name)
	return setmetatable({}, {
		__index = function(_, key)
			needsEngine(name .. "." .. tostring(key))
		end,
		__call = function()
			needsEngine(name .. "()")
		end,
		__metatable = "The metatable is locked",
	})
end

-- The project tree (default.project.json), as Rojo builds it.
local projectFile
if fs.isFile("default.project.json") then
	projectFile = "default.project.json"
else
	for _, entry in fs.readDir(".") do
		if entry:match("%.project%.json$") then
			projectFile = entry
			break
		end
	end
end
do
	local tree = { ["$className"] = "DataModel" }
	if projectFile then
		local ok, decoded = pcall(serde.decode, "json", fs.readFile(projectFile))
		if ok and type(decoded) == "table" and type(decoded.tree) == "table" then
			tree = decoded.tree
		else
			print("WARN couldn't read " .. projectFile .. "; script and game paths won't resolve")
		end
	end
	game = fromTree("game", tree, nil)
	game.className = "DataModel"
end
local workspaceStub
do
	local stub = newNode("Workspace", "Workspace", game)
	stub.engine = true
	ENGINE_SERVICES.Workspace = stub
	workspaceStub = proxy(stub)
end

local sharedG = {}
local SAFE_OS = { clock = os.clock, time = os.time, date = os.date, difftime = os.difftime }
local SAFE_TASK = { spawn = taskLib.spawn, defer = taskLib.defer, delay = taskLib.delay, wait = taskLib.wait, cancel = taskLib.cancel }
local DATATYPES = {
	"Axes", "BrickColor", "CFrame", "Color3", "ColorSequence", "ColorSequenceKeypoint", "Enum", "Faces", "Font",
	"NumberRange", "NumberSequence", "NumberSequenceKeypoint", "PhysicalProperties", "Ray", "Rect", "Region3",
	"Region3int16", "UDim", "UDim2", "Vector2", "Vector2int16", "Vector3", "Vector3int16",
}
local ENGINE_GLOBALS = { "Instance", "TweenInfo", "DateTime", "RaycastParams", "OverlapParams", "PathWaypoint", "DockWidgetPluginGuiInfo", "plugin", "settings", "UserSettings", "stats", "delay", "spawn", "wait" }

-- Roblox's Random, for game code that rolls numbers: same methods, not the same sequence as in Roblox.
local RandomMethods = {}
RandomMethods.__index = RandomMethods
local function nextU32(self)
	local x = self.state
	x = bit32.bxor(x, bit32.lshift(x, 13))
	x = bit32.bxor(x, bit32.rshift(x, 17))
	x = bit32.bxor(x, bit32.lshift(x, 5))
	self.state = x
	return x
end
local function newRandom(seed)
	local state = math.floor(math.abs(tonumber(seed) or os.clock() * 1e6)) % 4294967296
	return setmetatable({ state = if state == 0 then 0x9E3779B9 else state }, RandomMethods)
end
function RandomMethods:NextNumber(min, max)
	min, max = min or 0, max or 1
	return min + (max - min) * (nextU32(self) / 4294967296)
end
function RandomMethods:NextInteger(min, max)
	min, max = math.ceil(min), math.floor(max)
	return min + nextU32(self) % (max - min + 1)
end
function RandomMethods:NextUnitVector()
	local z = self:NextNumber(-1, 1)
	local angle = self:NextNumber(0, 2 * math.pi)
	local r = math.sqrt(1 - z * z)
	return roblox.Vector3.new(r * math.cos(angle), r * math.sin(angle), z)
end
function RandomMethods:Shuffle(t)
	for i = #t, 2, -1 do
		local j = self:NextInteger(1, i)
		t[i], t[j] = t[j], t[i]
	end
end
function RandomMethods:Clone()
	return setmetatable({ state = self.state }, RandomMethods)
end
local RandomLib = table.freeze({ new = newRandom })
local epoch = os.time() - os.clock()

local function typeofValue(value)
	if nodeOf[value] then
		return "Instance"
	end
	return typeof(value)
end

local cache, loading = {}, {}
local requireFrom

local function makeEnv(n, file, extra)
	local env = {
		assert = assert, error = error, pcall = pcall, xpcall = xpcall, select = select, type = type, typeof = typeofValue,
		tostring = tostring, tonumber = tonumber, pairs = pairs, ipairs = ipairs, next = next, rawget = rawget,
		rawset = rawset, rawequal = rawequal, rawlen = rawlen, setmetatable = setmetatable, getmetatable = getmetatable,
		unpack = table.unpack, newproxy = newproxy, gcinfo = gcinfo, print = print,
		warn = function(...)
			print("WARN", ...)
		end,
		math = math, string = string, table = table, coroutine = coroutine, bit32 = bit32, utf8 = utf8, buffer = buffer,
		vector = vector, os = SAFE_OS, task = SAFE_TASK, debug = { traceback = debug.traceback },
		tick = function()
			return epoch + os.clock()
		end,
		time = os.clock, elapsedTime = os.clock, Random = RandomLib,
		game = proxy(game), Game = proxy(game), workspace = workspaceStub, Workspace = workspaceStub,
		script = n and proxy(n) or nil, _G = sharedG, shared = sharedG,
	}
	for _, name in DATATYPES do
		env[name] = roblox[name]
	end
	for _, name in ENGINE_GLOBALS do
		env[name] = engineStub(name)
	end
	env.require = function(target)
		return requireFrom(file, target)
	end
	if extra then
		for k, v in extra do
			env[k] = v
		end
	end
	return env
end

local function loadFile(file, n, extra)
	local source = fs.readFile(file)
	local chunk = luau.load(source, { debugName = file, environment = makeEnv(n, file, extra), injectGlobals = false })
	return chunk()
end

local function resolveRelative(from, path)
	if path:sub(1, 1) == "@" or path:sub(1, 1) == "/" or path:find("\\", 1, true) then
		return nil
	end
	local parts = {}
	for part in (from:match("^(.*)/[^/]*$") or ""):gmatch("[^/]+") do
		table.insert(parts, part)
	end
	for part in path:gmatch("[^/]+") do
		if part == ".." then
			if #parts == 0 then
				return nil
			end
			table.remove(parts)
		elseif part ~= "." then
			table.insert(parts, part)
		end
	end
	local base = table.concat(parts, "/")
	for _, candidate in { base .. ".luau", base .. ".lua", base .. "/init.luau", base .. "/init.lua" } do
		if fs.isFile(candidate) then
			return candidate
		end
	end
	return nil
end

function requireFrom(fromFile, target)
	local file, n
	if type(target) == "string" then
		file = resolveRelative(fromFile, target)
		if not file then
			error("require: can't find " .. string.format("%q", target) .. " (only relative paths inside the game work here)", 3)
		end
		n = byFile[file]
	else
		n = nodeOf[target]
		if not n then
			error("require: expected a ModuleScript, got " .. typeofValue(target), 3)
		end
		if n.engine then
			needsEngine("require(" .. fullName(n) .. ")")
		end
		if n.className ~= "ModuleScript" or not n.file then
			error("require: " .. fullName(n) .. " is a " .. n.className .. ", not a ModuleScript", 3)
		end
		file = n.file
	end
	if cache[file] then
		return cache[file].value
	end
	if loading[file] then
		error("require: " .. file .. " was required while it was still loading (a require loop)", 3)
	end
	loading[file] = true
	local ok, value = pcall(loadFile, file, n)
	loading[file] = nil
	if not ok then
		error(value, 0)
	end
	cache[file] = { value = value }
	return value
end

-- Specs: every *.spec.luau (but *.cloud.spec.luau, which needs the engine) in the project.
local SKIP_DIRS = { node_modules = true, Packages = true, DevPackages = true, ServerPackages = true }
local function walkTree(n)
	for _, kid in list(n) do
		walkTree(kid)
	end
end
walkTree(game)
local specs = {}
local function walk(dir)
	for _, name in fs.readDir(dir) do
		local path = if dir == "." then name else dir .. "/" .. name
		if fs.isDir(path) then
			if not SKIP_DIRS[name] and name:sub(1, 1) ~= "." then
				walk(path)
			end
		elseif name:match("%.spec%.luau$") and not name:match("%.cloud%.spec%.luau$") then
			table.insert(specs, path)
		end
	end
end
walk(".")
table.sort(specs)

local function protect(fn, ...)
	return xpcall(fn, debug.traceback, ...)
end

local counts = { passed = 0, failed = 0, skipped = 0, engine = 0 }
local engineSpecs = {}
-- Failures are printed last, just before the totals: Hangar keeps the end of long output.
local failures = {}
for _, path in specs do
	local g, run = newTestEZ()
	local ok, value = protect(loadFile, path, byFile[path], g)
	local results
	if not ok then
		local status = if string.find(tostring(value), ENGINE_MARK, 1, true) then "engine" else "failed"
		results = { { name = path, status = status, error = "couldn't load: " .. tostring(value) } }
	else
		results = runSpec(value, path, protect, run)
	end
	local fileCounts = { passed = 0, failed = 0, skipped = 0, engine = 0 }
	for _, r in results do
		counts[r.status] += 1
		fileCounts[r.status] += 1
		if r.status == "failed" then
			-- The runner's own lines are left out of tracebacks: only the game's code matters.
			local lines = {}
			for line in (tostring(r.error) .. "\n"):gmatch("([^\n]*)\n") do
				if line ~= "" and not line:find("hangar-run-tests", 1, true) then
					table.insert(lines, line)
				end
			end
			table.insert(failures, "FAIL " .. r.name .. "\n    " .. table.concat(lines, "\n    "))
		end
	end
	if fileCounts.engine > 0 then
		local first
		for _, r in results do
			if r.status == "engine" then
				first = tostring(r.error):match("%[needs the game engine%] ([^\n]*)")
				break
			end
		end
		table.insert(engineSpecs, string.format("%s (%d tests, first: %s)", path, fileCounts.engine, first or "?"))
	end
end
if #specs == 0 then
	print("No *.spec.luau files found. The QA Tester can write some.")
	process.exit(1)
end
if #engineSpecs > 0 then
	print("Need the game engine (they run on the test place, not here):")
	for _, line in engineSpecs do
		print("  " .. line)
	end
end
for _, failure in failures do
	print(failure)
end
print(string.format("%d passed, %d failed, %d skipped, %d need the game engine, in %d spec files", counts.passed, counts.failed, counts.skipped, counts.engine, #specs))
process.exit(if counts.failed > 0 then 1 else 0)
`

/**
 * Hangar's smoke script, run by Open Cloud in a fresh server of the uploaded place version. It returns a
 * JSON report; Hangar reads it as untrusted data (the game code ran in the same server).
 */
export const CLOUD_SCRIPT =
  "-- Hangar smoke test: every ModuleScript must load, then every .spec ModuleScript's tests run.\n" +
  TESTEZ_SHIM +
  `local HttpService = game:GetService("HttpService")
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

local report = { modules = 0, loadErrors = {}, tests = {}, passed = 0, skipped = 0 }
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
	local results
	if not ok then
		results = { { name = spec:GetFullName(), status = "failed", error = "couldn't load: " .. tostring(suite) } }
	else
		local g, run = newTestEZ()
		if type(suite) == "function" then
			-- TestEZ style: the spec's describe/it/expect come from Hangar's runner.
			setfenv(suite, setmetatable(g, { __index = getfenv(suite) }))
		end
		results = runSpec(suite, spec:GetFullName(), within, run)
	end
	-- Only failures are listed (a game can have thousands of tests); passes and skips are counted.
	for _, r in results do
		if r.status == "passed" then
			report.passed += 1
		elseif r.status == "skipped" then
			report.skipped += 1
		else
			table.insert(report.tests, { name = r.name, ok = false, error = r.error })
		end
	end
end

return HttpService:JSONEncode(report)
`

const clip = (v: unknown, n: number): string => revealHidden(String(v ?? '')).slice(0, n)

/** Turn the smoke script's JSON report into a check status and readable output. */
export function readCloudReport(results: unknown): { status: 'passed' | 'failed' | 'error'; output: string } {
  const first = Array.isArray(results) ? results[0] : undefined
  let report: { modules?: unknown; loadErrors?: unknown; tests?: unknown; passed?: unknown; skipped?: unknown } | null = null
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
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  // Passes are counted by the script; older reports listed them one by one.
  let passed = count(report.passed)
  const skipped = count(report.skipped)
  let failed = 0
  for (const t of tests) {
    if (t?.ok === true) passed++
    else {
      failed++
      if (failed <= 100) lines.push(`FAIL ${clip(t?.name, 200)}`, `    ${clip(t?.error, 600).replace(/\n/g, '\n    ')}`)
    }
  }
  if (failed > 100) lines.push(`…and ${failed - 100} more failures`)
  lines.push(
    `${modules - loadErrors.length} of ${modules} modules loaded. ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}${passed + failed + skipped ? '' : ' (no .spec modules in the place)'}.`
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
