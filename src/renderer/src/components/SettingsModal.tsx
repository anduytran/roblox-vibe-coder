import { useState } from 'react'
import { attempt, setCosts, setKey, setSettings, toast, useStore, type SettingsTab } from '../store'
import { PhoneRemoteSection } from './PhoneRemoteSection'
import { Button, Field, Icon, Modal, resetsText, Toggle } from './ui'
import { getMotion, getTheme, setMotion, setTheme, type MotionChoice, type ThemeChoice } from '../theme'


const SETTINGS_TABS: [SettingsTab, string, string][] = [
  ['general', 'General', 'gear'],
  ['account', 'Account', 'key'],
  ['agents', 'Agents', 'agents'],
  ['limits', 'Usage & limits', 'gauge'],
  ['roblox', 'Roblox', 'cube'],
  ['phone', 'Phone', 'phone'],
  ['privacy', 'Privacy & security', 'shield']
]

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']

export function SettingsModal({ onClose, initialTab = 'general' }: { onClose: () => void; initialTab?: SettingsTab }) {
  const settings = useStore((s) => s.settings)
  const key = useStore((s) => s.key)
  const [keyDraft, setKeyDraft] = useState('')
  const [model, setModel] = useState(settings?.defaultModel ?? MODELS[0]!)
  const [concurrency, setConcurrency] = useState(String(settings?.maxConcurrentRuns ?? 3))
  const [perRun, setPerRun] = useState(String(settings?.perRunBudgetUsd ?? 2))
  const [daily, setDaily] = useState(settings?.globalDailyBudgetUsd?.toString() ?? '')
  const [studioCmd, setStudioCmd] = useState(settings?.studioMcpCommand ?? '')
  const [studioArgs, setStudioArgs] = useState((settings?.studioMcpArgs ?? []).join(' '))
  const [blenderCmd, setBlenderCmd] = useState(settings?.blenderMcpCommand ?? '')
  const [blenderArgs, setBlenderArgs] = useState((settings?.blenderMcpArgs ?? []).join(' '))
  const [hideKey, setHideKey] = useState(settings?.hideKeyFromAgents ?? true)
  const [rojo, setRojo] = useState(settings?.rojoCommand ?? 'rojo')
  const [authMode, setAuthMode] = useState<'apiKey' | 'max'>(settings?.authMode ?? 'apiKey')
  const [maxDraft, setMaxDraft] = useState('')
  const [fiveHourPct, setFiveHourPct] = useState(String(settings?.planLimits?.fiveHourPct ?? 90))
  const [weeklyPct, setWeeklyPct] = useState(String(settings?.planLimits?.weeklyPct ?? 80))
  const plan = useStore((s) => s.costs.plan)
  const [checkingPlan, setCheckingPlan] = useState(false)
  const refreshPlan = (): void => {
    setCheckingPlan(true)
    void attempt(async () => {
      const c = await window.hangar.costs.refreshPlan()
      setCosts(c)
      if (!c.plan?.weekly) toast("Couldn't read your plan usage. Run `claude auth login` in a terminal, then try again.", 'error')
    }).finally(() => setCheckingPlan(false))
  }
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme())
  const [motion, setMotionState] = useState<MotionChoice>(getMotion())
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  const saveKey = (): void => {
    void attempt(async () => {
      setKey(await window.hangar.key.set(keyDraft))
      setKeyDraft('')
      toast('API key saved securely.')
    })
  }

  // The sign-in choice applies at once (like the theme), so it can't be lost by closing without Save.
  const applyAuthMode = async (mode: 'apiKey' | 'max'): Promise<void> => {
    setAuthMode(mode)
    setSettings(await window.hangar.settings.set({ authMode: mode }))
    setKey(await window.hangar.key.status())
  }
  const chooseAuthMode = (mode: 'apiKey' | 'max'): void => {
    void attempt(async () => {
      await applyAuthMode(mode)
      toast(mode === 'max' ? 'Agents now use your Claude Max subscription.' : 'Agents now use your API key.')
    })
  }
  const saveMaxToken = (): void => {
    void attempt(async () => {
      await window.hangar.key.setMaxToken(maxDraft)
      setMaxDraft('')
      await applyAuthMode('max')
      toast('Claude Max token saved. Agents now use your subscription.')
    })
  }

  const save = (): void => {
    void attempt(async () => {
      const d = parseFloat(daily)
      const next = await window.hangar.settings.set({
        defaultModel: model,
        maxConcurrentRuns: parseInt(concurrency, 10),
        perRunBudgetUsd: parseFloat(perRun),
        globalDailyBudgetUsd: Number.isFinite(d) && d > 0 ? d : null,
        studioMcpCommand: studioCmd,
        studioMcpArgs: studioArgs.trim() ? studioArgs.trim().split(/\s+/) : [],
        blenderMcpCommand: blenderCmd,
        blenderMcpArgs: blenderArgs.trim() ? blenderArgs.trim().split(/\s+/) : [],
        hideKeyFromAgents: hideKey,
        rojoCommand: rojo,
        authMode: key.maxAvailable ? authMode : 'apiKey',
        planLimits: { fiveHourPct: parseFloat(fiveHourPct), weeklyPct: parseFloat(weeklyPct) }
      })
      setSettings(next)
      toast('Settings saved.')
      onClose()
    })
  }

  return (
    <Modal
      title="Settings"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {SETTINGS_TABS.map(([id, label, icon]) => (
            <button key={id} className={`settings-tab ${tab === id ? 'settings-tab-on' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane" key={tab}>
          {tab === 'general' && (
            <>
            <section className="card">
              <h3>Appearance</h3>
              <div className="segmented" role="radiogroup" aria-label="Theme">
                {(
                  [
                    ['system', 'System', 'monitor'],
                    ['light', 'Light', 'sun'],
                    ['dark', 'Dark', 'moon']
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={theme === value}
                    className={`segment ${theme === value ? 'segment-on' : ''}`}
                    onClick={() => {
                      setTheme(value)
                      setThemeState(value)
                    }}
                  >
                    <Icon name={icon} />
                    {label}
                  </button>
                ))}
              </div>
              <h3>Animations</h3>
              <div className="segmented" role="radiogroup" aria-label="Animations">
                {(
                  [
                    ['system', 'Match system'],
                    ['on', 'On'],
                    ['off', 'Off']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={motion === value}
                    className={`segment ${motion === value ? 'segment-on' : ''}`}
                    onClick={() => {
                      setMotion(value)
                      setMotionState(value)
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="muted small">Match system turns animations off when your computer's “Reduce motion” setting is on.</p>
            </section>
            <section className="card">
              <h3>Notifications</h3>
              <Toggle
                checked={settings?.notifications !== false}
                onChange={(v) => void attempt(async () => setSettings(await window.hangar.settings.set({ notifications: v })))}
                label="Notify me when something needs me"
                hint="A desktop notification when an approval, a review or a check-in is waiting and Hangar isn't the window you're using. It names the game only; click it to open the Inbox."
              />
            </section>
            </>
          )}
          {tab === 'account' && (
            <>
            {key.maxAvailable && (
              <section className="card">
                <h3>Claude Max (personal use)</h3>
                <p className="small">
                  Development builds only. Agents use your own Claude subscription instead of the API key. Anthropic doesn't allow this in apps you give to
                  other people, so shipped builds never offer it.
                </p>
                <div className="segmented" role="radiogroup" aria-label="Agents sign in with">
                  {(
                    [
                      ['apiKey', 'API key'],
                      ['max', 'Claude Max']
                    ] as const
                  ).map(([value, label]) => (
                    <button key={value} role="radio" aria-checked={authMode === value} className={`segment ${authMode === value ? 'segment-on' : ''}`} onClick={() => chooseAuthMode(value)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="small">
                  {key.hasMaxToken ? (
                    <>
                      <span className="ok">●</span> A subscription token is saved{key.encryptionAvailable ? ', encrypted with your OS keychain.' : ' for this session only.'}
                    </>
                  ) : (
                    <>
                      No token yet. Run <code>claude setup-token</code> in a terminal and paste the token it prints.
                    </>
                  )}
                </p>
                <div className="row gap-xs">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={maxDraft}
                    placeholder={key.hasMaxToken ? 'Paste a new token to replace it' : 'sk-ant-oat…'}
                    onChange={(e) => setMaxDraft(e.target.value)}
                  />
                  <Button tone="primary" disabled={!maxDraft.trim()} onClick={saveMaxToken}>
                    Save token
                  </Button>
                  {key.hasMaxToken && (
                    <Button tone="danger" onClick={() => void attempt(async () => setKey(await window.hangar.key.clearMaxToken()))}>
                      Remove
                    </Button>
                  )}
                </div>
                {authMode === 'max' && (
                  <p className="small warn">
                    The token can't be hidden behind Hangar's proxy, so agents hold it directly. In autonomous or auto-run projects, commands an agent runs
                    could read it. It lasts a year: revoke it at claude.ai if it ever leaks. Busy autopilot runs use your plan's limits faster than chatting does.
                  </p>
                )}
              </section>
            )}

            <section className="card">
              <h3>Anthropic API key</h3>
              <p className="small">
                {key.hasKey ? (
                  <>
                    <span className="ok">●</span> A key is saved{key.encryptionAvailable ? ', encrypted with your OS keychain.' : ' for this session only.'}
                  </>
                ) : (
                  'No key yet. Create one in the Claude Console (console.anthropic.com → API keys).'
                )}
              </p>
              {!key.encryptionAvailable && (
                <p className="small warn">Your system can't encrypt secrets, so the key is kept in memory only and you'll need to re-enter it next launch.</p>
              )}
              <div className="row gap-xs">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyDraft}
                  placeholder={key.hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <Button tone="primary" disabled={!keyDraft.trim()} onClick={saveKey}>
                  Save key
                </Button>
                {key.hasKey && (
                  <Button tone="danger" onClick={() => void attempt(async () => setKey(await window.hangar.key.clear()))}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="muted small">The key is never sent to this window. Use a dedicated key with a spending limit set in the Claude Console.</p>
            </section>
            </>
          )}
          {tab === 'agents' && (
            <>
            <section className="card">
              <h3>Agents</h3>
              <div className="grid-2">
                <Field label="Default model">
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {[...new Set([model, ...MODELS])].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Agents running at once" hint="Others wait in their queues.">
                  <input inputMode="numeric" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
                </Field>
              </div>
            </section>
            </>
          )}
          {tab === 'limits' && (
            <>
            {authMode === 'max' ? (
              <section className="card">
                <div className="row between">
                  <h3>Claude plan limits</h3>
                  <Button size="sm" tone="ghost" disabled={checkingPlan} onClick={refreshPlan}>
                    {checkingPlan ? 'Checking…' : 'Refresh'}
                  </Button>
                </div>
                <p className="small">
                  {plan?.fiveHour || plan?.weekly ? (
                    <>
                      Now: 5-hour window {plan.fiveHour ? `${plan.fiveHour.usedPct}% used${plan.fiveHour.resetsAt ? `, ${resetsText(plan.fiveHour.resetsAt)}` : ''}` : 'unknown'} · week{' '}
                      {plan.weekly ? `${plan.weekly.usedPct}% used${plan.weekly.resetsAt ? `, ${resetsText(plan.weekly.resetsAt)}` : ''}` : 'unknown'}.
                    </>
                  ) : (
                    <>
                      No usage yet. Hangar reads it through your Claude Code login: run <code>claude auth login</code> in a terminal once, then click
                      Refresh.
                    </>
                  )}
                </p>
                <div className="grid-2">
                  <Field label="Stop at, 5-hour window (%)" hint="No new tasks start past this. Running ones finish.">
                    <input inputMode="numeric" value={fiveHourPct} onChange={(e) => setFiveHourPct(e.target.value)} />
                  </Field>
                  <Field label="Stop at, this week (%)" hint="Keeps some of the week for you to use Claude yourself.">
                    <input inputMode="numeric" value={weeklyPct} onChange={(e) => setWeeklyPct(e.target.value)} />
                  </Field>
                </div>
                <Field label="Per-task safety stop (estimated USD)" hint="Stops one runaway task. On Max it's an estimate, not a charge.">
                  <input inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
                </Field>
                <p className="muted small">With Claude Max, these replace the daily dollar limits. Autopilot pauses when a limit is reached and tells you when it resets.</p>
              </section>
            ) : (
              <section className="card">
                <h3>Spending limits</h3>
                <div className="grid-2">
                  <Field label="Per-task limit (USD)" hint="A single run stops when it reaches this.">
                    <input inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
                  </Field>
                  <Field label="Daily limit, all projects (USD)" hint="Empty = no daily limit.">
                    <input inputMode="decimal" value={daily} placeholder="No limit" onChange={(e) => setDaily(e.target.value)} />
                  </Field>
                </div>
                <p className="muted small">Costs are the SDK's own estimates; check the Claude Console for exact billing.</p>
              </section>
            )}
            </>
          )}
          {tab === 'roblox' && (
            <>
            <section className="card">
              <h3>Roblox Studio connection</h3>
              <p className="small muted">
                Leave empty to use Roblox's default for your OS (Windows: %LOCALAPPDATA%\Roblox\mcp.bat, macOS: RobloxStudio.app's StudioMCP). Override only if
                Studio is installed somewhere else; Studio shows the exact command under Assistant Settings → MCP Servers.
              </p>
              <div className="grid-2">
                <Field label="Command">
                  <input value={studioCmd} onChange={(e) => setStudioCmd(e.target.value)} placeholder="Platform default" />
                </Field>
                <Field label="Arguments">
                  <input value={studioArgs} onChange={(e) => setStudioArgs(e.target.value)} placeholder="Space-separated" />
                </Field>
              </div>
            </section>

            <section className="card">
              <h3>Publishing</h3>
              <Field label="Rojo command" hint="Used to build a reviewed branch when you publish it to a test place.">
                <input value={rojo} onChange={(e) => setRojo(e.target.value)} placeholder="rojo" />
              </Field>
            </section>
              <section className="card">
                <h3>Blender</h3>
                <p className="small muted">
                  For the Blender 3D modeler. Install Blender and the blender-mcp add-on, start its server inside Blender, then enter the command that connects to it,
                  for example <code>uvx</code> with arguments <code>blender-mcp</code>. Leave empty to keep Blender off. Every step that runs code in Blender asks you
                  first, because Blender is not sandboxed.
                </p>
                <div className="grid-2">
                  <Field label="Command">
                    <input value={blenderCmd} onChange={(e) => setBlenderCmd(e.target.value)} placeholder="Off" />
                  </Field>
                  <Field label="Arguments">
                    <input value={blenderArgs} onChange={(e) => setBlenderArgs(e.target.value)} placeholder="Space-separated" />
                  </Field>
                </div>
              </section>
            </>
          )}
          {tab === 'phone' && (
            <>
            <PhoneRemoteSection />
            </>
          )}
          {tab === 'privacy' && (
            <>
            <section className="card">
              <h3>API key protection</h3>
              <Toggle
                checked={hideKey}
                onChange={setHideKey}
                label="Hide API key from agents (recommended)"
                hint="Agents get a temporary token that only works through Hangar on this computer; Hangar adds the real key when talking to Anthropic. Turn off only if agents can't connect."
              />
              <p className="muted small">
                The key is never sent to this window. {hideKey ? 'With hiding on, agents and the commands they run never see it.' : 'With hiding off, the Claude engine holds the key, so commands an agent runs could read it.'} Either way, use a dedicated key with a spending limit set in the Claude Console.
              </p>
            </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
