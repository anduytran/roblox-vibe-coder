import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Project, StudioSyncState } from '../src/shared/types'
import { rokitManifest } from '../src/main/scaffold'
import { findRojo, StudioSync } from '../src/main/studioSync'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const exe = (file: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
}

test('studio: Rokit launchers are skipped for the newest official Rojo already installed', () => {
  const home = tmp('hangar-home-')
  for (const v of ['7.7.0', '7.10.1', '7.7.1', 'not-a-version']) exe(join(home, '.rokit', 'tool-storage', 'rojo-rbx', 'rojo', v, 'rojo'))
  assert.equal(findRojo('definitely-not-on-path-rojo', home, 'darwin'), join(home, '.rokit', 'tool-storage', 'rojo-rbx', 'rojo', '7.10.1', 'rojo'))
  // A full path set in Settings is used as is.
  const custom = join(tmp('hangar-bin-'), 'rojo')
  exe(custom)
  assert.equal(findRojo(custom, home, 'darwin'), custom)
  // A launcher given as a full path is still skipped.
  const shim = join(home, '.rokit', 'bin', 'rojo')
  exe(shim)
  assert.equal(findRojo(shim, home, 'darwin'), join(home, '.rokit', 'tool-storage', 'rojo-rbx', 'rojo', '7.10.1', 'rojo'))
  assert.equal(findRojo('definitely-not-on-path-rojo', tmp('hangar-empty-'), 'darwin'), null)
})

test('studio: new games list the Rokit tools already installed, at their newest version', () => {
  const home = tmp('hangar-home2-')
  for (const p of ['rojo-rbx/rojo/7.7.1', 'rojo-rbx/rojo/7.7.0', 'Kampfkarren/selene/0.28.0', 'evil/rojo/9.9.9']) mkdirSync(join(home, '.rokit', 'tool-storage', p), { recursive: true })
  const toml = rokitManifest(home)!
  assert.match(toml, /rojo = "rojo-rbx\/rojo@7\.7\.1"/)
  assert.match(toml, /selene = "Kampfkarren\/selene@0\.28\.0"/)
  assert.doesNotMatch(toml, /stylua|evil/)
  assert.equal(rokitManifest(tmp('hangar-nohome-')), null)
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  killed = false
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

function game(files: Record<string, string>): Project {
  const dir = tmp('hangar-sync-')
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return { id: 'p1', name: 'Game', path: dir, createdAt: 1, settings: {} as Project['settings'] }
}

test('studio: sync serves the project on localhost, reports when it is live, and stops', () => {
  const states: StudioSyncState[] = []
  const spawned: { cmd: string; args: string[]; cwd: string }[] = []
  let child!: FakeChild
  const sync = new StudioSync({
    rojo: () => '/opt/rojo',
    emit: (s) => states.push(s),
    spawnFn: ((cmd: string, args: string[], opts: { cwd: string }) => {
      spawned.push({ cmd, args, cwd: opts.cwd })
      child = new FakeChild()
      return child
    }) as never
  })
  const p = game({ 'default.project.json': JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src' } } }) })
  assert.equal(sync.start(p).status, 'starting')
  assert.deepEqual(spawned[0], { cmd: '/opt/rojo', args: ['serve', 'default.project.json', '--address', '127.0.0.1', '--port', '34872'], cwd: p.path })
  child.stdout.emit('data', Buffer.from('Rojo server listening:\n  Address: 127.0.0.1\n  Port:    34872\n'))
  assert.equal(sync.status().status, 'running')
  assert.equal(sync.stop().status, 'off')
  assert.equal(child.killed, true)
  assert.equal(sync.status().status, 'off', 'a stop is not reported as a crash')
  // Rojo exits on its own: the reason is shown.
  sync.start(p)
  child.stderr.emit('data', Buffer.from('error: Address already in use (os error 48)\n'))
  child.exitCode = 1
  child.emit('exit', 1)
  assert.equal(sync.status().status, 'error')
  assert.match(sync.status().message ?? '', /Port 34872 is busy/)
})

test('studio: refuses project files that reach outside the game, a missing project file, or no Rojo', () => {
  const sync = new StudioSync({ rojo: () => '/opt/rojo', emit: () => {}, spawnFn: (() => new FakeChild()) as never })
  const outside = game({ 'default.project.json': JSON.stringify({ name: 'g', tree: { $className: 'DataModel', X: { $path: '../../.ssh' } } }) })
  assert.match(sync.start(outside).message ?? '', /point outside the game/)
  assert.match(sync.start(game({ 'README.md': 'hi' })).message ?? '', /No Rojo project file/)
  const none = new StudioSync({ rojo: () => null, emit: () => {} })
  assert.match(none.start(game({ 'default.project.json': '{}' })).message ?? '', /isn't installed/)
})
