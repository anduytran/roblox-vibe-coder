import assert from 'node:assert/strict'
import { test } from 'node:test'

test('checks sandbox (macOS): a checkout inside the unreadable data folder can still resolve its own path', { skip: process.platform !== 'darwin' }, async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { sandboxCommand } = await import('../src/main/checks')
  const app = mkdtempSync(join(tmpdir(), 'hangar-appdata-'))
  writeFileSync(join(app, 'secret.json'), 'SECRET')
  const work = join(app, 'builds', 'check-1')
  mkdirSync(join(work, 'tree'), { recursive: true })
  const run = (args: string[]) => {
    const w = sandboxCommand('darwin', '/bin/sh', ['-c', ...args], { work, appDataDir: app })!
    return spawnSync(w.file, w.argv, { cwd: join(work, 'tree'), encoding: 'utf8' })
  }
  assert.equal(run(['/bin/pwd -P']).status, 0, 'like Rojo: works out where it is')
  assert.notEqual(run([`cat ${JSON.stringify(join(app, 'secret.json'))}`]).status, 0, "Hangar's data stays unreadable")
  assert.notEqual(run([`ls ${JSON.stringify(app)}`]).status, 0, 'and unlisted')
})
