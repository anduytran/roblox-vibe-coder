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
