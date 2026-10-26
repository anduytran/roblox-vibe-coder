import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
  )
}

test('window code: effects have block bodies, so they never return a value React would call as cleanup', () => {
  // An expression body returns its value: scrollIntoView, for one, returns a promise in newer Chromium,
  // which crashed Brainstorm with "destroy is not a function".
  const bad = sources(join(__dirname, '..', 'src', 'renderer', 'src')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${file.split('/src/renderer/src/')[1]}:${i + 1}` }))
      .filter(({ line }) => /use(Layout)?Effect\(\s*(\(\)\s*=>\s*[^{\s]|[A-Za-z_$][\w$]*\s*,)/.test(line))
      .map(({ at }) => at)
  )
  assert.deepEqual(bad, [])
})

test('window code: no system confirm() dialogs and no raw HTML injection', () => {
  const offenders = sources(join(__dirname, '..', 'src', 'renderer', 'src')).flatMap((file) => {
    const src = readFileSync(file, 'utf8')
    const rel = file.split('/src/renderer/src/')[1]
    const found: string[] = []
    // window.confirm / bare confirm( — Hangar's own dialog is confirmDialog().
    if (/(^|[^\w.])confirm\(|window\.confirm\(/m.test(src)) found.push(`${rel}: confirm()`)
    if (/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(src)) found.push(`${rel}: raw HTML`)
    return found
  })
  assert.deepEqual(offenders, [])
})
