import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppSettings } from '../src/shared/types'
import { EngineCredentials, validateApiKey, validateMaxToken } from '../src/main/engineCredentials'

const API_KEY = 'sk-ant-api03-abcdefghijklmnop'
const MAX_TOKEN = 'sk-ant-oat01-abcdefghijklmnop'

function setup(opts: { allowed: boolean; mode: AppSettings['authMode']; hide?: boolean }) {
  const settings: AppSettings = { defaultModel: 'm', maxConcurrentRuns: 1, perRunBudgetUsd: 1, globalDailyBudgetUsd: null, studioMcpCommand: '', studioMcpArgs: [], hideKeyFromAgents: opts.hide ?? true, rojoCommand: 'rojo', authMode: opts.mode, planLimits: { fiveHourPct: 90, weeklyPct: 80 } }
  const revoked: string[] = []
  const creds = new EngineCredentials({
    personalModeAllowed: opts.allowed,
    getSettings: () => settings,
    getApiKey: () => API_KEY,
    getMaxToken: () => MAX_TOKEN,
    keyProxy: { start: async () => {}, issueToken: () => 'run-token', baseUrl: () => 'http://127.0.0.1:1', revokeToken: (t) => revoked.push(t) }
  })
  return { creds, revoked }
}

test('max mode: the subscription token goes to the engine directly, never with an API key or proxy', async () => {
  const { creds } = setup({ allowed: true, mode: 'max' })
  assert.equal(creds.get(), MAX_TOKEN)
  const a = await creds.auth(creds.get()!, { forceHideKey: false })
  assert.deepEqual(a.env, { CLAUDE_CODE_OAUTH_TOKEN: MAX_TOKEN })
  assert.equal(a.note, undefined)
  const unattended = await creds.auth(creds.get()!, { forceHideKey: true })
  assert.deepEqual(unattended.env, { CLAUDE_CODE_OAUTH_TOKEN: MAX_TOKEN })
  assert.match(unattended.note ?? '', /subscription token/)
})

test('max mode is ignored in packaged builds: the API key and its proxy are used', async () => {
  const { creds, revoked } = setup({ allowed: false, mode: 'max' })
  assert.equal(creds.usingMax(), false)
  assert.equal(creds.get(), API_KEY)
  const a = await creds.auth(creds.get()!, { forceHideKey: false })
  assert.deepEqual(a.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'run-token' })
  a.release()
  assert.deepEqual(revoked, ['run-token'])
})

test('api key mode: hidden behind the proxy unless hiding is off and nothing forces it', async () => {
  const { creds } = setup({ allowed: true, mode: 'apiKey', hide: false })
  assert.deepEqual((await creds.auth(API_KEY, { forceHideKey: false })).env, { ANTHROPIC_API_KEY: API_KEY })
  assert.equal((await creds.auth(API_KEY, { forceHideKey: true })).env.ANTHROPIC_API_KEY, 'run-token')
})

test('api keys and subscription tokens are not mixed up', () => {
  assert.equal(validateApiKey(API_KEY), null)
  assert.match(validateApiKey(MAX_TOKEN) ?? '', /subscription token/)
  assert.equal(validateMaxToken(MAX_TOKEN), null)
  assert.notEqual(validateMaxToken(API_KEY), null)
  assert.notEqual(validateMaxToken('sk-ant-oat01-short'), null)
})
