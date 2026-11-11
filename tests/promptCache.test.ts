import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAgentEnv, isSprintPiece } from '../src/main/agentRunner'

// Autopilot's pieces, reviews and one-off replies use the 5-minute cache (writes cost 1.25x input, not 2x).

test('cache: sprint pieces get the 5-minute cache; the Lead, planner and your own chats keep the hour', () => {
  assert.equal(buildAgentEnv({}, {}, { shortCache: true }).FORCE_PROMPT_CACHING_5M, '1')
  assert.equal(buildAgentEnv({}, {}).FORCE_PROMPT_CACHING_5M, undefined)
  assert.equal(buildAgentEnv({}, { FORCE_PROMPT_CACHING_5M: '1' }).FORCE_PROMPT_CACHING_5M, undefined, 'never from Hangar\'s own environment')
  assert.equal(isSprintPiece({ origin: 'autopilot', prompt: 'Autopilot item abc1, sprint 3: Boss' }), true)
  assert.equal(isSprintPiece({ origin: 'autopilot', prompt: 'Autopilot: plan sprint 3' }), false)
  assert.equal(isSprintPiece({ prompt: 'Autopilot item x' }), false, 'you typing it is a chat')
})
