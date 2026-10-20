import type { ProjectSettings } from '@shared/types'
import { isProtectedPath, patternEscapes, pathsFromToolInput, relativeInside } from './pathScope'

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | {
      action: 'ask'
      reason: string
      /** Shown in red; never offered as "always allow". */
      dangerous: boolean
      /** Whether an "Always allow" button may be offered for this call. */
      canAlwaysAllow: boolean
    }

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'Agent'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const STUDIO_MCP_NAME = 'Roblox_Studio'
/** Read-only Roblox Studio MCP tools: inspecting the game and playtest output is safe to allow. */
const STUDIO_READ_TOOLS = new Set([
  'script_read',
  'script_search',
  'script_grep',
  'search_game_tree',
  'inspect_instance',
  'get_studio_state',
  'get_console_output',
  'screen_capture',
  'list_roblox_studios'
])

/**
 * Studio tools an autonomous agent may use without asking: playtesting, running test scripts in play
 * mode (changes are thrown away when play stops) and simulated player input. Still asking: running
 * Luau in edit mode (execute_luau can rewrite scripts, insert assets or use the network outside git
 * review), inserting Toolbox assets (common source of backdoor scripts), AI generation, uploads,
 * Studio's own web fetch, and direct script edits.
 */
const STUDIO_AUTONOMOUS_TOOLS = new Set([
  'start_stop_play',
  'get_studio_mode',
  'run_script_in_play_mode',
  'character_navigation',
  'user_keyboard_input',
  'user_mouse_input'
])

// ---------- shell commands ----------

/**
 * A command can only be auto-allowed if every word is plain: letters, digits and . _ / @ + , -
 * That rules out quoting, variables ($, %), home paths (~), globs, escapes, redirection,
 * chaining and `--flag=value` forms in one go.
 */
const SAFE_WORD = /^[A-Za-z0-9._/@+,-]+$/

/**
 * "Always allow this exact command" is only offered for these programs: project tooling and
 * read-only utilities. Anything else (interpreters, shells, package managers, build tools,
 * installers, downloaders, file deleters, sed/awk…) is approved one run at a time.
 */
const ALWAYS_OK_PROGRAMS = new Set([
  'rojo', 'selene', 'stylua', 'luau-lsp', 'luau-analyze', 'git', 'ls', 'dir', 'pwd', 'tree', 'rg', 'grep', 'wc',
  'head', 'tail', 'cat', 'type', 'echo', 'which', 'where', 'stat', 'file', 'du', 'diff'
])
/** git subcommands that only read, or stage files. */
const GIT_ALWAYS_OK = new Set(['status', 'diff', 'log', 'show', 'branch', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog', 'add'])
/** Flags that make otherwise harmless tools write files, change config or run programs. */
const RISKY_FLAGS = /^(--pre|--pre-glob|--hostname-bin|-o|--output|--ext-diff|--textconv|-c|-C|--exec|--exec-path|--upload-pack|--plugin|--config|-e|--eval|-x|--git-dir|--work-tree)$/i

export function shellWords(command: string): string[] | null {
  const words = command.trim().split(/[ \t]+/).filter(Boolean)
  if (words.length === 0) return null
  return words.every((w) => SAFE_WORD.test(w)) ? words : null
}

/**
 * The program's plain name for comparison: last path segment, lower case, without .exe/.cmd/.bat/.ps1/.com
 * and without a trailing version (python3.12 -> python, node22 -> node).
 */
export function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '')
    .replace(/[\d.]+$/, '')
}

/** An extra argument after an allow rule: must be a plain relative path or name, never a flag. */
function isSafeArgument(word: string): boolean {
  return !word.startsWith('-') && !word.startsWith('/') && !word.split('/').includes('..')
}

/**
 * True if `command` is covered by one of the user's allow rules.
 * A rule matches the command exactly. A rule ending in " *" also allows extra words after it,
 * but only plain relative file names (no flags, absolute paths or "..").
 */
export function commandAllowed(command: string, rules: string[]): boolean {
  if (/[\r\n]/.test(command)) return false
  const words = shellWords(command)
  if (!words) return false
  return rules.some((raw) => {
    const rule = raw.trim()
    const wildcard = rule.endsWith(' *')
    const ruleWords = shellWords(wildcard ? rule.slice(0, -2) : rule)
    if (!ruleWords || ruleWords.length > words.length) return false
    if (!ruleWords.every((w, i) => words[i] === w)) return false
    const extra = words.slice(ruleWords.length)
    return extra.length === 0 || (wildcard && extra.every(isSafeArgument))
  })
}

/** The rule saved for "Always allow this command": the exact command, or null if it may not be saved. */
export function alwaysRuleFor(command: string): string | null {
  if (/[\r\n]/.test(command)) return null
  const words = shellWords(command)
  if (!words) return null
  const [program, sub] = words
  if (!program) return null
  // A program given by path (/usr/bin/python3, C:/x/node.exe) is never saved: the name could hide anything.
  if (/[\\/]/.test(program)) return null
  const name = programName(program)
  if (!ALWAYS_OK_PROGRAMS.has(name)) return null
  if (name === 'git' && (!sub || !GIT_ALWAYS_OK.has(sub.toLowerCase()))) return null
  if (words.slice(1).some((w) => RISKY_FLAGS.test(w))) return null
  return words.join(' ')
}

/** Commands that could print environment variables (the API key lives there). */
function mayRevealSecrets(command: string): boolean {
  return /ANTHROPIC|API_KEY|_TOKEN|SECRET/.test(command) || /(^|[\s;&|(])(env|printenv|set|export)(\s|$)/.test(command) || /env:/i.test(command)
}

/**
 * Invisible, look-alike-blank or direction-changing characters that can make an approval card lie:
 * control characters (C0, DEL, C1), zero-width and bidi controls, soft hyphen, Arabic letter mark,
 * Hangul fillers, line/paragraph separators, BOM, and Unicode tag characters (\"ASCII smuggling\").
 * Written as escapes on purpose, so this file contains no invisible characters itself.
 */
export const DECEPTIVE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u

/** Every string inside a tool input (checked raw, before any JSON escaping hides control characters). */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    out.push(k)
    allStrings(x, out)
  }
  return out
}

// ---------- policy ----------

/**
 * Decide what happens to a tool call before it runs.
 * Default posture: reading inside the project is free; anything that changes things, runs
 * commands, reaches the network or leaves the project folder asks first. Edits to files that
 * control execution (.git, .claude, .mcp.json, CLAUDE.md, CI/editor config) always ask in red.
 */
export function evaluateToolUse(args: {
  toolName: string
  input: Record<string, unknown>
  projectRoot: string
  settings: ProjectSettings
}): PolicyDecision {
  const { toolName, input, projectRoot, settings } = args
  const ask = (reason: string, dangerous = false, canAlwaysAllow = !dangerous): PolicyDecision => ({
    action: 'ask',
    reason,
    dangerous,
    canAlwaysAllow: canAlwaysAllow && !dangerous
  })

  if (allStrings(input).some((str) => DECEPTIVE_CHARS.test(str))) {
    return ask('Contains hidden or direction-changing characters — check the details carefully', true)
  }

  const paths = pathsFromToolInput(input)
  const rels = paths.map((p) => relativeInside(projectRoot, p))
  const outside = paths.filter((_, i) => rels[i] === null)
  if (outside.length > 0) return ask(`Touches a path outside the project folder: ${outside.join(', ')}`, true)

  const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined
  if (typeof pattern === 'string' && patternEscapes(pattern)) return ask(`Searches outside the project folder: ${pattern}`, true)

  if (READ_TOOLS.has(toolName)) return { action: 'allow' }

  const studioPrefix = `mcp__${STUDIO_MCP_NAME}__`
  if (settings.robloxStudioMcp && toolName.startsWith(studioPrefix)) {
    const tool = toolName.slice(studioPrefix.length)
    if (STUDIO_READ_TOOLS.has(tool)) return { action: 'allow' }
    if (settings.autonomous && STUDIO_AUTONOMOUS_TOOLS.has(tool)) return { action: 'allow' }
  }

  if (EDIT_TOOLS.has(toolName)) {
    const protectedRel = rels.find((r): r is string => r !== null && isProtectedPath(r, projectRoot))
    if (protectedRel) {
      return ask(`Edits ${protectedRel}, which controls how code or agents run. A change here could let an agent run commands later.`, true)
    }
    if (settings.autonomous || settings.autoApproveEdits || settings.alwaysAllowTools.includes(toolName)) return { action: 'allow' }
    return ask('Edits a file in the project')
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    // The engine's "run this outside the sandbox" switch is never honoured.
    if (input.dangerouslyDisableSandbox === true) {
      return { action: 'deny', reason: 'Hangar does not allow commands to run outside the sandbox. Try a different approach that works inside the project folder.' }
    }
  }

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (mayRevealSecrets(command)) return ask('This command may print environment variables or secrets, including your API key', true)
    if (commandAllowed(command, settings.allowedBashPrefixes)) return { action: 'allow' }
    return ask(shellWords(command) ? 'Runs a shell command' : 'Runs a shell command with special characters (quotes, variables, chaining or redirection)', false, alwaysRuleFor(command) !== null)
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    // Never "always": a standing web permission is an exfiltration channel for injected instructions.
    return ask('Reaches the internet', false, false)
  }

  if (settings.alwaysAllowTools.includes(toolName)) return { action: 'allow' }
  // "Always allow" for a whole tool is only offered for Roblox Studio's tools. Other MCP servers and
  // unknown tools can do anything, including touching files without the path checks above.
  if (toolName.startsWith(studioPrefix)) return ask('Calls a Roblox Studio tool that changes your game')
  if (toolName.startsWith('mcp__')) return ask('Calls a connected tool (MCP)', false, false)
  return ask(`Uses ${toolName}`, false, false)
}

/** One-line human summary of a tool call for the approval card and activity feed. */
export function summarizeToolUse(toolName: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  switch (toolName) {
    case 'Bash':
      return `$ ${s('command') ?? ''}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${toolName} ${s('file_path') ?? s('notebook_path') ?? ''}`
    case 'Glob':
      return `Glob ${s('pattern') ?? ''}`
    case 'Grep':
      return `Grep "${s('pattern') ?? ''}"${s('path') ? ` in ${s('path')}` : ''}`
    case 'WebFetch':
      return `Fetch ${s('url') ?? ''}`
    case 'WebSearch':
      return `Search "${s('query') ?? ''}"`
    case 'Task':
    case 'Agent':
      return `Delegate to ${s('subagent_type') ?? 'subagent'}: ${s('description') ?? ''}`
    default:
      return `${toolName} ${JSON.stringify(input)}`
  }
}
