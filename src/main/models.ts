import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ModelFile, ModelRequest } from '@shared/types'
import { isInsideRoot } from './pathScope'

/** Where the Blender modeler exports meshes (with a .png preview of the same name). */
export const MESH_DIR = 'assets/models'
/** Where the Studio modeler saves each model as a Luau builder script. */
export const BUILDER_DIR = 'src/shared/Models'

const MESH_EXT = new Set(['.fbx', '.obj', '.glb', '.gltf'])
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
/** All previews in one listing together, so a project full of images can't flood the window. */
const PREVIEW_BUDGET_BYTES = 20 * 1024 * 1024
const MAX_FILES = 200

/** Plain files directly in a project folder; links are skipped so a listing never reads outside the project. */
function filesIn(root: string, rel: string): { name: string; path: string; mtime: number; size: number }[] {
  const dir = join(root, rel)
  if (!existsSync(dir) || !isInsideRoot(root, dir)) return []
  try {
    if (!lstatSync(dir).isDirectory()) return []
  } catch {
    return []
  }
  return readdirSync(dir)
    .slice(0, MAX_FILES * 2)
    .flatMap((name) => {
      try {
        const st = lstatSync(join(dir, name))
        return st.isFile() ? [{ name, path: `${rel}/${name}`, mtime: st.mtimeMs, size: st.size }] : []
      } catch {
        return []
      }
    })
}

/** The project's 3D models, newest first. `previews: false` skips reading preview images. */
export function listModels(projectRoot: string, opts: { previews?: boolean } = {}): ModelFile[] {
  const withPreviews = opts.previews ?? true
  let budget = PREVIEW_BUDGET_BYTES
  const meshes = filesIn(projectRoot, MESH_DIR).sort((a, b) => b.mtime - a.mtime)
  const pngs = new Map(meshes.filter((f) => extname(f.name).toLowerCase() === '.png').map((f) => [basename(f.name, extname(f.name)).toLowerCase(), f]))
  const models: ModelFile[] = []
  for (const f of meshes) {
    if (!MESH_EXT.has(extname(f.name).toLowerCase())) continue
    const stem = basename(f.name, extname(f.name))
    const png = pngs.get(stem.toLowerCase())
    let preview: string | null = null
    if (withPreviews && png && png.size <= MAX_PREVIEW_BYTES && png.size <= budget) {
      budget -= png.size
      try {
        const bytes = readFileSync(join(projectRoot, png.path))
        // Only real PNGs become previews (checked by signature, not by name).
        if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) preview = `data:image/png;base64,${bytes.toString('base64')}`
      } catch {
        // no preview
      }
    }
    models.push({ name: stem, kind: 'mesh', file: f.path, preview, updatedAt: f.mtime })
  }
  for (const f of filesIn(projectRoot, BUILDER_DIR)) {
    if (!/\.luau?$/i.test(f.name)) continue
    models.push({ name: f.name.replace(/\.luau?$/i, ''), kind: 'builder', file: f.path, preview: null, updatedAt: f.mtime })
  }
  return models.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_FILES)
}

/** A model name that is safe as a file name and a Luau identifier: letters, digits, spaces become CamelCase. */
export function modelFileName(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const camel = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').slice(0, 40)
  return /^[A-Za-z]/.test(camel) ? camel : `Model${camel}`
}

const SIZE: Record<ModelRequest['size'], { studs: string; parts: number; tris: number }> = {
  prop: { studs: 'about 2-6 studs', parts: 60, tris: 3000 },
  character: { studs: 'about 5-6 studs tall', parts: 90, tris: 6000 },
  vehicle: { studs: 'about 10-16 studs long', parts: 150, tris: 8000 },
  building: { studs: 'about 20-40 studs wide', parts: 300, tris: 15000 }
}

const STYLE: Record<ModelRequest['style'], string> = {
  'low-poly': 'low-poly, flat-shaded, few colors',
  blocky: 'blocky, classic Roblox look',
  stylized: 'stylized and chunky, bold shapes and colors',
  detailed: 'more detailed, still game-ready'
}

/** Checks a model request from the UI and turns it into the modeler's task. */
export function modelTask(projectRoot: string, raw: unknown): { roleId: string; name: string; prompt: string } {
  const r = (raw ?? {}) as Partial<ModelRequest>
  const method = r.method === 'blender' ? 'blender' : 'studio'
  const description = typeof r.description === 'string' ? r.description.trim().slice(0, 2000) : ''
  if (!description) throw new Error('Describe the model first.')
  const name = modelFileName(typeof r.name === 'string' && r.name.trim() ? r.name : description.split(/\s+/).slice(0, 3).join(' '))
  const size = SIZE[typeof r.size === 'string' && Object.hasOwn(SIZE, r.size) ? r.size : 'prop']
  const style = STYLE[typeof r.style === 'string' && Object.hasOwn(STYLE, r.style) ? r.style : 'low-poly']
  const what = `Make a 3D model named ${name}: ${description}\nStyle: ${style}. Size: ${size.studs}.`
  if (method === 'studio') {
    return {
      roleId: 'studio-modeler',
      name,
      prompt: `${what}\nBuild it in Roblox Studio under workspace.HangarModels.${name}, using at most ${size.parts} parts. Save the builder script as ${BUILDER_DIR}/${name}.luau.`
    }
  }
  const out = join(projectRoot, MESH_DIR)
  return {
    roleId: 'blender-modeler',
    name,
    prompt: `${what}\nModel it in Blender in at most ${size.tris} triangles. Export the FBX to ${join(out, `${name}.fbx`)} and render the preview to ${join(out, `${name}.png`)} (create the folder if needed). Write nothing anywhere else.`
  }
}
