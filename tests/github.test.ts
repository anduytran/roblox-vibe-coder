import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { githubLink, linkGitHub, parseGitHubRepo, pullFromGitHub, pushToGitHub, unlinkGitHub } from '../src/main/git'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

function repo(): { dir: string; g: (...a: string[]) => string } {
  const dir = tmp('hangar-gh-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'me@example.com')
  g('config', 'user.name', 'Me')
  writeFileSync(join(dir, 'game.luau'), 'print("v1")\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  return { dir, g }
}

test('parseGitHubRepo accepts page, https and ssh links and normalises them', () => {
  for (const s of ['https://github.com/me/my-game', 'https://github.com/me/my-game.git', 'github.com/me/my-game/', ' https://www.github.com/me/my-game ']) {
    assert.deepEqual(parseGitHubRepo(s), { owner: 'me', name: 'my-game', url: 'https://github.com/me/my-game.git', webUrl: 'https://github.com/me/my-game' })
  }
  for (const s of ['git@github.com:me/my-game.git', 'ssh://git@github.com/me/my-game']) {
    assert.equal(parseGitHubRepo(s)?.url, 'git@github.com:me/my-game.git')
  }
})

test('parseGitHubRepo refuses anything that is not a plain GitHub repository', () => {
  for (const s of [
    '',
    'http://github.com/me/game',
    'https://gitlab.com/me/game',
    'https://github.com.evil.com/me/game',
    'https://github.com/me/game/tree/main',
    'https://github.com/me/..',
    'https://github.com/-me/game',
    'https://github.com/me/-u',
    'ext::sh -c touch% /tmp/pwned',
    '/tmp/some/repo',
    'file:///tmp/repo',
    'https://github.com/me/ga me'
  ]) {
    assert.equal(parseGitHubRepo(s), null, s)
  }
})

test('link, change and unlink set origin without sending anything', async () => {
  const { dir, g } = repo()
  assert.deepEqual(await githubLink(dir), { isRepo: true, repo: null, webUrl: null, otherRemote: null, branch: 'main' })
  const linked = await linkGitHub(dir, 'https://github.com/me/my-game')
  assert.equal(linked.repo, 'me/my-game')
  assert.equal(g('config', '--get', 'remote.origin.url').trim(), 'https://github.com/me/my-game.git')
  assert.equal((await linkGitHub(dir, 'git@github.com:me/other.git')).repo, 'me/other')
  assert.equal(g('config', '--get', 'remote.origin.url').trim(), 'git@github.com:me/other.git')
  assert.equal((await unlinkGitHub(dir)).repo, null)
  assert.equal(g('remote').trim(), '')
  await assert.rejects(linkGitHub(dir, 'https://example.com/x/y'), /isn't a GitHub repository/)
})

test('an origin that is not on GitHub is reported, and never pushed to', async () => {
  const { dir, g } = repo()
  const bare = tmp('hangar-gh-bare-')
  execFileSync('git', ['init', '-q', '--bare', bare])
  g('remote', 'add', 'origin', bare)
  assert.equal((await githubLink(dir)).otherRemote, bare)
  await assert.rejects(pushToGitHub(dir), /Link a GitHub repository first/)
  assert.equal(execFileSync('git', ['for-each-ref'], { cwd: bare }).toString(), '')
})

test('a planted insteadOf cannot turn a GitHub push into a local one', async () => {
  const { dir, g } = repo()
  const bare = tmp('hangar-gh-bare-')
  execFileSync('git', ['init', '-q', '--bare', bare])
  await linkGitHub(dir, 'https://github.com/me/my-game')
  g('config', `url.${bare}.insteadOf`, 'https://github.com/me/my-game.git')
  await assert.rejects(pushToGitHub(dir))
  assert.equal(execFileSync('git', ['for-each-ref'], { cwd: bare }).toString(), '')
})

test('push and pull refuse task branches; pull refuses uncommitted changes', async () => {
  const { dir, g } = repo()
  await linkGitHub(dir, 'https://github.com/me/my-game')
  writeFileSync(join(dir, 'game.luau'), 'print("v2")\n')
  await assert.rejects(pullFromGitHub(dir), /uncommitted changes/)
  g('checkout', '-q', '.')
  g('checkout', '-q', '-b', 'hangar/scripter-x-abc123')
  await assert.rejects(pushToGitHub(dir), /task branch/)
  await assert.rejects(pullFromGitHub(dir), /task branch/)
})

test('not a repository: nothing to link', async () => {
  const dir = tmp('hangar-gh-none-')
  assert.equal((await githubLink(dir)).isRepo, false)
  await assert.rejects(linkGitHub(dir, 'https://github.com/me/my-game'), /isn't a git repository/)
})
