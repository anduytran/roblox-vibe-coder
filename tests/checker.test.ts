import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalExplanation, ApprovalRequest } from '../src/shared/types'
import { checkerMayApprove } from '../src/main/approvalExplainer'

const req = (extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'a1',
  projectId: 'p',
  agentId: 'lead',
  toolName: 'Bash',
  summary: '$ cat design-vault/Roadmap.md',
  inputJson: '{}',
  reason: 'Runs a shell command',
  dangerous: false,
  canAlwaysAllow: true,
  truncated: false,
  ts: 1,
  ...extra
})
const safe = (extra: Partial<ApprovalExplanation> = {}): ApprovalExplanation => ({
  approvalId: 'a1',
  status: 'done',
  verdict: 'safe',
  aiVerdict: 'safe',
  what: 'Prints the roadmap.',
  touches: ['design-vault/Roadmap.md'],
  writes: false,
  deletes: false,
  network: false,
  reasons: ['Only reads a project file'],
  flags: [],
  costUsd: 0.01,
  error: null,
  ...extra
})

test('safety checker: approves only a plainly safe, ordinary action that Hangar found nothing about', () => {
  assert.equal(checkerMayApprove(req(), safe()), true)
  assert.equal(checkerMayApprove(req({ dangerous: true }), safe()), false, 'high-risk always waits for you')
  assert.equal(checkerMayApprove(req({ truncated: true }), safe()), false, 'only actions shown in full')
  assert.equal(checkerMayApprove(req({ toolName: 'Project setup' }), safe()), false)
  assert.equal(checkerMayApprove(req(), safe({ aiVerdict: 'careful', verdict: 'careful' })), false)
  assert.equal(checkerMayApprove(req(), safe({ flags: [{ kind: 'network', text: 'Uses the internet' } as never] })), false, "any of Hangar's own flags means no")
  assert.equal(checkerMayApprove(req(), safe({ deletes: true })), false)
  assert.equal(checkerMayApprove(req(), safe({ network: true })), false)
  assert.equal(checkerMayApprove(req(), safe({ status: 'error' })), false, 'no answer, no approval')
  assert.equal(checkerMayApprove(req(), safe({ approvalId: 'other' })), false, 'the answer must be about this request')
  assert.equal(checkerMayApprove(req(), null), false)
})

test("safety checks: Lua's ~= (not equal) isn't a path in your home folder; ~/x still is", async () => {
  const { approvalFlags } = await import('../src/main/approvalExplainer')
  const flags = (command: string) => approvalFlags({ ...req(), summary: `$ ${command}`, inputJson: JSON.stringify({ command }) }, { projectRoot: '/tmp/game' }).flags.map((f) => f.text)
  assert.deepEqual(flags('echo part.LocalTransparencyModifier ~= 0'), [])
  assert.ok(flags('cat ~/.ssh/id_rsa').length > 0)
})
