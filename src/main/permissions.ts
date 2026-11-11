import type { ProjectSettings } from '@shared/types'
import { isProtectedPath, patternEscapes, pathsFromToolInput, relativeInside, linkInPath } from './pathScope'
import { DECEPTIVE_CHARS } from '@shared/text'
import { sandboxAutoRun } from './sandbox'
import { requestedSkill } from './skills'

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
/** Hangar's own Blender connection. Distinctive, so a project's own "blender" server never gets its pre-approved tools. */
export const BLENDER_MCP_NAME = 'Hangar_Blender'
/** Blender tools that only look at the scene. Everything else asks; running code asks in red. */
const BLENDER_READ_TOOLS = new Set(['get_scene_info', 'get_object_info', 'get_viewport_screenshot'])
/**
 * Every Roblox Studio tool runs without asking (your choice, 2026-11-11: Studio work runs on its own), through
 * Hangar's own Studio connection only, before the file-path rules (a Studio "path" is a place in the game, not a file).
 * Only hidden or direction-changing characters still ask. Accepted risks are in SECURITY.md.
 */

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

/**
 * Commands that could print environment variables (the API key lives there). The shell commands that print them
 * (`env`, `set`, `export`…) are looked for only in the part the shell runs, not in text it hands to another program
 * (a heredoc for Python, a quoted string): an agent writing "height set by its content" into a note isn't running
 * `set`. Anything run as shell code again (sh, bash, eval, source…) is checked whole. Names of secret variables and
 * the ways programs read the environment (os.environ, process.env…) are looked for everywhere.
 */
export function mayRevealSecrets(command: string): boolean {
  return (
    /ANTHROPIC|API_KEY|_TOKEN\b|SECRET|GIT_CONFIG_|oauth_token/.test(command) ||
    /anthropic|claude-max-token/i.test(command) ||
    PRINTS_ENV.test(shellCode(command)) ||
    /\/proc\/[^\s]*\/environ|process\.env|os\.environ|getenv|environ\b|%ENV|\$ENV\{|ENV\[|Environment\]::|GetEnvironmentVariable|Get-ChildItem\s+env:|\$env:|\bgci\s+env:|\bls\s+env:|\bdir\s+env:/i.test(command)
  )
}

/** Shell commands that print variables: `env`, `printenv`, `set` or `export` on their own, `declare`/`typeset`/`compgen`. */
const PRINTS_ENV =
  /(^|[\s;&|(`{'"])(env|printenv|declare|typeset|compgen)(?=[\s;&|)`}'"]|$)|(^|[\s;&|(`{'"])(set|export)(?=\s*(?:$|[;&|)`}'"])|\s+-p\b)/m

/** Runs text as shell code again: then nothing in it is data. */
const RUNS_SHELL = /(^|[\s;&|(`{/])(sh|bash|zsh|dash|ksh|fish|eval|source|exec|xargs|parallel|watch|script|su|sudo|doas|nohup|timeout|nice|command|builtin)(?=[\s;&|)`}]|$)|(^|[\s;&|(`{])\.\s/

/**
 * The part of a command the shell itself runs: heredoc bodies and quoted strings removed (they're text for another
 * program), unless the command runs text as shell code again. Double-quoted strings with a substitution in them stay.
 */
export function shellCode(command: string): string {
  if (RUNS_SHELL.test(command)) return command
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    kept.push(line)
    const open = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line)
    if (!open) continue
    const dash = open[1] === '-'
    while (i + 1 < lines.length && (dash ? lines[i + 1]!.replace(/^\t+/, '') : lines[i + 1]) !== open[3]) i++
    i++
  }
  return kept
    .join('\n')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => (/\$\(|`/.test(m) ? m : '""'))
}

// Shared with the window, which strips the same characters from agent-written text it renders.
export { DECEPTIVE_CHARS }

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
  /** This run's commands are in the OS sandbox and the agent doesn't hold the real API key. */
  sandboxed?: boolean
  /** Skills this agent may load (Skill tool). Missing or empty: none. */
  enabledSkills?: string[]
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

  const studioPrefix = `mcp__${STUDIO_MCP_NAME}__`
  if (settings.robloxStudioMcp && toolName.startsWith(studioPrefix)) return { action: 'allow' }

  // A skill is text the agent reads; it never adds tools. Only the agent's own chosen skills load.
  if (toolName === 'Skill') {
    const id = requestedSkill(input)
    if (id && args.enabledSkills?.includes(id)) return { action: 'allow' }
    return { action: 'deny', reason: `That skill isn't turned on for this agent. Skills it can use: ${args.enabledSkills?.length ? args.enabledSkills.join(', ') : 'none'}.` }
  }

  const paths = pathsFromToolInput(input)
  const rels = paths.map((p) => relativeInside(projectRoot, p))
  const outside = paths.filter((_, i) => rels[i] === null)
  if (outside.length > 0) return ask(`Touches a path outside the project folder: ${outside.join(', ')}`, true)

  const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined
  if (typeof pattern === 'string' && patternEscapes(pattern)) return ask(`Searches outside the project folder: ${pattern}`, true)

  if (READ_TOOLS.has(toolName)) return { action: 'allow' }


  const blenderPrefix = `mcp__${BLENDER_MCP_NAME}__`
  if (toolName.startsWith(blenderPrefix)) {
    const tool = toolName.slice(blenderPrefix.length)
    if (BLENDER_READ_TOOLS.has(tool)) return { action: 'allow' }
    // Blender runs this Python with your full permissions, outside any sandbox and outside the project checks.
    if (tool === 'execute_blender_code') return ask('Runs Python in Blender with your full permissions (not sandboxed). Read the code before allowing.', true)
    return ask('Calls a Blender tool (it may download assets or change files)', false, false)
  }

  if (EDIT_TOOLS.has(toolName)) {
    const link = paths.map((p) => linkInPath(projectRoot, p)).find((l): l is string => l !== null)
    if (link) return ask(`Writes through ${link}, which is a link (it could point outside the project).`, true)
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

  if (toolName === 'PowerShell' && mayRevealSecrets(typeof input.command === 'string' ? input.command : '')) {
    return ask('This command may print environment variables or secrets, including your API key', true)
  }

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (mayRevealSecrets(command)) return ask('This command may print environment variables or secrets, including your API key', true)
    if (commandAllowed(command, settings.allowedBashPrefixes)) return { action: 'allow' }
    // The sandbox keeps the command inside the project, off the network and away from credentials.
    if (args.sandboxed && sandboxAutoRun(settings)) return { action: 'allow' }
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
