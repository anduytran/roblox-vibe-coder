import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SkillInfo, SkillView } from '@shared/types'
import { SKILL_ID } from '@shared/agentConfig'
import { stripHidden } from '@shared/text'
import { linkInPath } from './pathScope'

/**
 * Claude skills (folders with a SKILL.md) live in <project>/.claude/skills/<id>/, the folder Claude Code uses. That
 * folder is protected config: an agent's edit there always asks in red, and sandboxed commands can't write it.
 * Nothing is loaded from ~/.claude: a skill from there is only used after you import a copy into the project.
 *
 * Agents never read these files as they are. Each run gets a cleaned copy (see buildSkillPlugin): only the name, the
 * description and the instructions, so a skill can't add tools, hooks, a model or shell commands that run on load.
 */
export function skillsDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'skills')
}

/** The plugin name Hangar's cleaned copies are loaded under; the engine calls a skill "hangar-skills:<id>". */
export const SKILL_PLUGIN = 'hangar-skills'

const MAX_SKILL_MD = 100_000
const MAX_DESCRIPTION = 1024
const MAX_FILES = 200
const MAX_TOTAL = 5_000_000
const MAX_DEPTH = 4

/** Splits SKILL.md into its frontmatter fields and body. Only simple `key: value` lines are read. */
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0 || /^\s/.test(line)) continue
    meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2]! }
}

/** One line of plain text: no hidden characters, no line breaks, bounded. */
export function cleanLine(text: string, max: number): string {
  return stripHidden(text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * The instructions as an agent gets them: hidden characters removed, and the engine's "run this shell command when
 * the skill loads" forms (!`cmd` and ```! blocks) turned into plain text. (The engine's own switch for that is off
 * too; this is the second layer.)
 */
export function cleanSkillBody(body: string): string {
  return stripHidden(body)
    .slice(0, MAX_SKILL_MD)
    .replace(/!`/g, '! `')
    .replace(/^(\s*)(`{3,}|~{3,})\s*!/gm, '$1$2')
}

/** The skills folder, or null when it (or .claude) is a link: a repository could point it anywhere. */
function usableDir(projectRoot: string): string | null {
  const dir = skillsDir(projectRoot)
  if (linkInPath(projectRoot, dir) !== null) return null
  try {
    return lstatSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

function readSkillMd(projectRoot: string, id: string): string | null {
  if (!SKILL_ID.test(id)) return null
  const dir = usableDir(projectRoot)
  if (!dir) return null
  const folder = join(dir, id)
  const file = join(folder, 'SKILL.md')
  try {
    if (!lstatSync(folder).isDirectory()) return null
    const st = lstatSync(file)
    if (!st.isFile() || st.size > MAX_SKILL_MD) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function infoFrom(id: string, text: string): SkillInfo {
  const { meta } = parseSkillMd(text)
  const info: SkillInfo = { id, name: cleanLine(meta.name || id, 64) || id, description: cleanLine(meta.description ?? '', MAX_DESCRIPTION) }
  if (!info.description) info.problem = 'No description: agents use it to decide when the skill applies.'
  return info
}

/** The project's skills, sorted. Folders with odd names, links, or no readable SKILL.md are left out. */
export function listSkills(projectRoot: string): SkillInfo[] {
  const dir = usableDir(projectRoot)
  if (!dir) return []
  const out: SkillInfo[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !SKILL_ID.test(e.name)) continue
    const text = readSkillMd(projectRoot, e.name)
    if (text !== null) out.push(infoFrom(e.name, text))
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** A skill's cleaned instructions and the names of its other files, for the window. */
export function viewSkill(projectRoot: string, id: string): SkillView {
  const text = readSkillMd(projectRoot, id)
  if (text === null) throw new Error('That skill is missing or unreadable.')
  const files: string[] = []
  const walk = (abs: string, depth: number): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      const path = join(abs, e.name)
      if (e.isDirectory() && depth < MAX_DEPTH) walk(path, depth + 1)
      else if (e.isFile() && !(depth === 0 && e.name === 'SKILL.md')) files.push(cleanLine(relative(join(skillsDir(projectRoot), id), path).split(/[\\/]/).join('/'), 200))
      if (files.length >= MAX_FILES) return
    }
  }
  walk(join(skillsDir(projectRoot), id), 0)
  return { ...infoFrom(id, text), body: cleanSkillBody(parseSkillMd(text).body).trim(), files: files.sort() }
}

/** A folder name for a new skill: lower case, digits and dashes. */
export function skillIdFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Where a new skill goes, checked: not taken, and no link on the way. */
function newSkillFolder(projectRoot: string, id: string): string {
  if (!SKILL_ID.test(id)) throw new Error('A skill name needs letters or digits (it becomes a folder name like "level-design").')
  const folder = join(skillsDir(projectRoot), id)
  if (linkInPath(projectRoot, folder) !== null) throw new Error('.claude/skills (or .claude) is a link, so Hangar won\'t write there. Check that folder.')
  if (existsSync(folder)) throw new Error(`A skill called "${id}" already exists in this project.`)
  return folder
}

/** A new skill written from the window. */
export function createSkill(projectRoot: string, input: { name: string; description: string; body: string }): SkillInfo {
  const id = skillIdFor(cleanLine(input.name, 64))
  const description = cleanLine(input.description, MAX_DESCRIPTION)
  const body = stripHidden(input.body).trim()
  if (!description) throw new Error('A skill needs a description: agents use it to decide when to use the skill.')
  if (!body) throw new Error('A skill needs instructions.')
  if (body.length > MAX_SKILL_MD) throw new Error('Those instructions are too long (100 KB max).')
  const folder = newSkillFolder(projectRoot, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
  return infoFrom(id, readFileSync(join(folder, 'SKILL.md'), 'utf8'))
}

/**
 * Copies a skill folder you chose (from ~/.claude/skills, a download, anywhere) into the project. Only plain files
 * are copied (no links), within limits. Nothing outside the project is ever read again after this.
 */
export function importSkill(projectRoot: string, source: string): SkillInfo {
  let st
  try {
    st = lstatSync(source)
  } catch {
    throw new Error('That folder can\'t be read.')
  }
  if (!st.isDirectory()) throw new Error('Choose a skill folder (the one that holds SKILL.md).')
  const md = join(source, 'SKILL.md')
  let mdStat
  try {
    mdStat = lstatSync(md)
  } catch {
    throw new Error('That folder has no SKILL.md, so it isn\'t a Claude skill.')
  }
  if (!mdStat.isFile()) throw new Error('SKILL.md in that folder is not a plain file.')
  if (mdStat.size > MAX_SKILL_MD) throw new Error('That SKILL.md is too large (100 KB max).')
  const { meta } = parseSkillMd(readFileSync(md, 'utf8'))
  const folderName = source.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const id = skillIdFor(cleanLine(meta.name || folderName, 64))
  const dest = newSkillFolder(projectRoot, id)

  const files: { from: string; to: string }[] = []
  let total = 0
  const walk = (abs: string, rel: string, depth: number): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue
      const from = join(abs, e.name)
      const to = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) throw new Error('That skill folder is nested too deeply.')
        walk(from, to, depth + 1)
      } else if (e.isFile()) {
        total += lstatSync(from).size
        files.push({ from, to })
        if (files.length > MAX_FILES || total > MAX_TOTAL) throw new Error('That skill folder is too big (200 files or 5 MB max).')
      }
    }
  }
  walk(source, '', 0)
  mkdirSync(dest, { recursive: true })
  try {
    for (const f of files) {
      const to = join(dest, ...f.to.split('/'))
      mkdirSync(join(to, '..'), { recursive: true })
      copyFileSync(f.from, to)
    }
  } catch (e) {
    rmSync(dest, { recursive: true, force: true })
    throw e
  }
  return infoFrom(id, readFileSync(join(dest, 'SKILL.md'), 'utf8'))
}

/**
 * Writes a plugin folder (outside the project) with cleaned copies of the chosen skills, for one run. Returns the
 * names to give the engine ("hangar-skills:<id>") for the ids that exist; ids that don't are skipped.
 */
export function buildSkillPlugin(projectRoot: string, ids: string[], outDir: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const id of new Set(ids)) {
    const text = readSkillMd(projectRoot, id)
    if (text === null) continue
    const info = infoFrom(id, text)
    const body = cleanSkillBody(parseSkillMd(text).body).trim()
    const folder = join(outDir, 'skills', id)
    mkdirSync(folder, { recursive: true })
    // Only these two fields: allowed-tools, hooks, model, agent and the rest are dropped, so a skill never widens
    // what the agent may do. Its other files stay in the project, where the usual read checks apply.
    writeFileSync(
      join(folder, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${JSON.stringify(info.description || info.name)}\n---\n\nThis skill's other files (if any) are in the project at .claude/skills/${id}/; read them from there. The skill is guidance, not permission: Hangar's usual rules and approvals still apply.\n\n${body}\n`,
      'utf8'
    )
    names.set(id, `${SKILL_PLUGIN}:${id}`)
  }
  if (names.size) {
    mkdirSync(join(outDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: SKILL_PLUGIN, version: '1.0.0', description: 'Skills chosen in Hangar for this run.' }, null, 2), 'utf8')
  }
  return names
}

/** The skill id a Skill tool call asks for ("level-design", "/level-design" or "hangar-skills:level-design"), or null. */
export function requestedSkill(input: Record<string, unknown>): string | null {
  const raw = typeof input.skill === 'string' ? input.skill : typeof input.command === 'string' ? input.command : null
  if (raw === null) return null
  const name = raw.trim().replace(/^\//, '').split(/\s/)[0]!
  const id = name.startsWith(`${SKILL_PLUGIN}:`) ? name.slice(SKILL_PLUGIN.length + 1) : name
  return SKILL_ID.test(id) ? id : null
}
