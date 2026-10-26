import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentState, LogEntry, Project, QueuedTask, Role } from '@shared/types'
import { groupFeed, runSummary, sizeLabel, type FeedItem, type ToolCall } from '@shared/feed'
import { firstLine, revealCodeHidden, revealHidden } from '@shared/text'
import { attempt, confirmDialog, EMPTY_AGENTS, EMPTY_ROLES, getState, refreshProjects, setRoles, toast, useStore } from '../store'
import { ApprovalCard } from './ApprovalCard'
import { RoleEditor } from './RoleEditor'
import { EmptyState } from './EmptyState'
import { Button, Icon, StatusPill, timeAgo, usd } from './ui'

const MAIN_AGENT: Role = {
  id: 'main',
  name: 'Main',
  description: 'General-purpose agent with full project context. Good for anything that does not fit a role.',
  prompt: ''
}

export function AgentsView({ project }: { project: Project }) {
  const roles = useStore((s) => s.roles[project.id] ?? EMPTY_ROLES)
  const agents = useStore((s) => s.agents[project.id] ?? EMPTY_AGENTS)
  const approvals = useStore((s) => s.approvals)
  // Opened from Home or the Inbox for a particular agent: start on it.
  const focus = useStore((s) => s.focus)
  const [selected, setSelected] = useState(() => getState().focus?.agentId ?? 'main')
  useEffect(() => {
    if (focus?.agentId) setSelected(focus.agentId)
  }, [focus])
  const [editing, setEditing] = useState<Role | null>(null)

  const all = useMemo(() => [MAIN_AGENT, ...roles], [roles])
  useEffect(() => {
    if (!all.some((r) => r.id === selected)) setSelected('main')
  }, [all, selected])

  const role = all.find((r) => r.id === selected) ?? MAIN_AGENT
  const state = agents[role.id]

  return (
    <div className="agents">
      <div className="board">
        <div className="board-head">
          <span className="side-label">Agents</span>
          <div className="row gap-xs">
            {roles.length === 0 && (
              <Button
                size="sm"
                onClick={() =>
                  void attempt(async () => {
                    setRoles(project.id, await window.hangar.roles.installTemplates(project.id))
                    toast('Added Lead, Scripter, UI Builder and QA Tester roles.')
                  })
                }
                title="Adds four starter roles to .claude/agents in this project"
              >
                Add starter roles
              </Button>
            )}
            <Button size="sm" tone="ghost" onClick={() => setEditing({ id: '', name: '', description: '', prompt: '' })}>
              + New role
            </Button>
          </div>
        </div>
        {all.map((r) => {
          const a = agents[r.id]
          const waiting = approvals.filter((x) => x.projectId === project.id && x.agentId === r.id).length
          return (
            <button
              key={r.id}
              className={`agent-card agent-card-${waiting ? 'awaiting_approval' : (a?.status ?? 'idle')} ${selected === r.id ? 'agent-card-active' : ''}`}
              aria-current={selected === r.id ? 'true' : undefined}
              onClick={() => setSelected(r.id)}
            >
              <div className="agent-card-top">
                <span className="agent-name">
                  {r.name}
                  {r.mode === 'research' && (
                    <span className="agent-kind" title="Web researcher">
                      <Icon name="globe" size={13} />
                    </span>
                  )}
                </span>
                <StatusPill status={a?.status ?? 'idle'} />
              </div>
              <div className="agent-activity">{waiting ? `${waiting} action${waiting > 1 ? 's need' : ' needs'} approval` : (a?.activity ?? r.description)}</div>
              <div className="agent-meta">
                {a && a.queue.length > 0 && <span>{a.queue.length} queued</span>}
                {a && a.costUsd > 0 && <span>{usd(a.costUsd)} this session</span>}
              </div>
            </button>
          )
        })}
      </div>
      <AgentPanel
        key={`${project.id}:${role.id}`}
        project={project}
        role={role}
        state={state}
        onEdit={role.id === 'main' ? undefined : () => setEditing(role)}
      />
      {editing && <RoleEditor project={project} role={editing} onClose={() => setEditing(null)} onSaved={(id) => setSelected(id)} />}
    </div>
  )
}

export function AgentPanel(props: { project: Project; role: Role; state: AgentState | undefined; onEdit?: () => void }) {
  const { project, role, state } = props
  const allApprovals = useStore((s) => s.approvals)
  const approvals = useMemo(() => allApprovals.filter((a) => a.projectId === project.id && a.agentId === role.id), [allApprovals, project.id, role.id])
  const [draft, setDraft] = useState('')
  const [record, setRecord] = useState(false)
  // Grouped by default; the raw log shows every entry exactly as it was recorded.
  const [raw, setRaw] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const log = state?.log ?? EMPTY_LOG
  const busy = state?.status === 'working' || state?.status === 'awaiting_approval'
  const items = useMemo(() => (raw ? [] : groupFeed(log)), [log, raw])
  // The tool calls and runs you opened. Kept here, not in each row, so a row stays open when its stretch of
  // calls folds into a run.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const setOpen = useCallback((keys: string[], on: boolean) => {
    setOpened((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log[log.length - 1]?.id, log.length, approvals.length, raw])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void attempt(() => window.hangar.agents.send(project.id, role.id, text, { record }))
  }
  // Taking autopilot's own step out of the queue pauses autopilot, so it never waits on a task that won't run.
  const confirmAutopilot = (tasks: QueuedTask[]): Promise<boolean> =>
    tasks.some((t) => t.origin)
      ? confirmDialog({ title: "Remove autopilot's task?", body: 'Autopilot pauses. Resume it from the Overview to queue its next step again.', confirmLabel: 'Remove and pause', tone: 'danger' })
      : Promise.resolve(true)
  const removeQueued = (task: QueuedTask): void => {
    void confirmAutopilot([task]).then((ok) => {
      if (ok) void attempt(() => window.hangar.agents.removeQueued(project.id, role.id, task.id))
    })
  }
  const clearQueue = (): void => {
    void confirmAutopilot(state?.queue ?? []).then((ok) => {
      if (ok) void attempt(() => window.hangar.agents.clearQueue(project.id, role.id))
    })
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <div className="row gap-sm">
            <h2>{role.name}</h2>
            <StatusPill status={state?.status ?? 'idle'} />
          </div>
          <p className="muted small panel-desc" title={role.description}>
            {role.description}
          </p>
          {role.mode === 'research' && (
            <p className="role-badge">Web researcher · searches and reads public web pages only · its reports wait in Reviews until you approve them</p>
          )}
        </div>
        <div className="row gap-xs">
          {props.onEdit && (
            <Button size="sm" tone="ghost" onClick={props.onEdit}>
              Edit role
            </Button>
          )}
          <Button size="sm" tone="ghost" aria-pressed={raw} disabled={log.length === 0} title="Every log entry as recorded, without grouping" onClick={() => {
              // Positions don't carry over between the two views: land on the latest entries.
              stick.current = true
              setRaw(!raw)
            }}>
            {raw ? 'Grouped view' : 'Raw log'}
          </Button>
          <Button
            size="sm"
            tone="ghost"
            disabled={busy || log.length === 0}
            title="Start a fresh conversation (the agent forgets this session)"
            onClick={() => void attempt(() => window.hangar.agents.resetSession(project.id, role.id))}
          >
            New session
          </Button>
          <Button size="sm" tone="danger" disabled={!busy && state?.status !== 'queued'} onClick={() => void attempt(() => window.hangar.agents.stop(project.id, role.id))}>
            Stop
          </Button>
        </div>
      </header>

      {state?.lastError && state.status === 'error' && <div className="error-bar">{state.lastError}</div>}

      <div
        className="feed"
        ref={feedRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {log.length === 0 && approvals.length === 0 && (
          <EmptyState icon="agents" title={`Give ${role.name} a task`}>
            <p>Small, specific requests work best, for example:</p>
            <code className="empty-example">
              {role.mode === 'research'
                ? 'What are the current DataStore limits and best practices for saving player inventories?'
                : 'Add a 3-second cooldown to the dash augment and playtest it.'}
            </code>
          </EmptyState>
        )}
        {raw ? log.map((e) => <FeedEntry key={e.id} entry={e} />) : items.map((it, i) => <FeedRow key={it.key} item={it} live={busy && i === items.length - 1} opened={opened} setOpen={setOpen} />)}
        {/* The cards themselves are pinned below, so they're in view however long the feed is. */}
        {approvals.length > 0 && (
          <div className="entry entry-marker">
            {approvals.length === 1 ? 'Waiting for your approval' : `${approvals.length} actions waiting for your approval`} ↓
          </div>
        )}
        {state?.activity && busy && approvals.length === 0 && <div className="activity">{state.activity}</div>}
      </div>

      {approvals.length > 0 && (
        <div className="approval-strip" role="region" aria-label="Waiting for your approval">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} request={a} onDecided={(d) => d === 'always' && void refreshProjects()} />
          ))}
        </div>
      )}

      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? `Queue another task for ${role.name}…` : `Message ${role.name}…`}
          // While an approval is pinned above, the box shrinks to one line so the card's buttons stay in view.
          rows={approvals.length ? 1 : 3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-foot">
          <span className="muted small">
            Enter to send · Shift+Enter for a new line{busy ? ' · new messages are queued' : ''}
            {/* With an approval pinned above, the queue is just a count until it's answered (room for the card's buttons). */}
            {approvals.length > 0 && state && state.queue.length > 0 ? ` · ${state.queue.length} queued` : ''}
            {role.mode === 'research'
              ? ' · Web only · no project access'
              : `${project.settings.robloxStudioMcp ? ' · Roblox Studio tools on' : ''}${
                  project.settings.sandbox && (window.hangar.platform === 'darwin' || window.hangar.platform === 'linux') ? ' · Sandboxed' : ' · Not sandboxed'
                }`}
          </span>
          {project.settings.robloxStudioMcp && role.mode !== 'research' && (
            <label className="record-check" title="Record a short clip of the agent's playtest for the review">
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} /> Record playtest
            </label>
          )}
          <Button tone="primary" disabled={!draft.trim()} onClick={send}>
            {busy ? 'Queue' : 'Send'}
          </Button>
        </div>
        {state && state.queue.length > 0 && approvals.length === 0 && (
          <div className="queue-chips">
            <span className="side-label" id={`queue-${role.id}`}>
              Up next ({state.queue.length})
            </span>
            <ol className="queue-chip-list" aria-labelledby={`queue-${role.id}`}>
              {state.queue.map((q, i) => {
                const text = firstLine(q.prompt) || 'Task'
                return (
                  <li key={q.id} className="queue-chip" title={revealHidden(q.prompt.slice(0, 2000))}>
                    <span className="queue-chip-n">{i + 1}</span>
                    {q.origin && <span className="tag">autopilot</span>}
                    <span className="queue-chip-text">{text}</span>
                    <button className="icon-btn" aria-label={`Remove “${text}” from the queue`} onClick={() => removeQueued(q)}>
                      ×
                    </button>
                  </li>
                )
              })}
            </ol>
            {state.queue.length > 1 && (
              <button className="link small" onClick={clearQueue}>
                Clear all
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const EMPTY_LOG: LogEntry[] = []

type Opened = { opened: ReadonlySet<string>; setOpen: (keys: string[], on: boolean) => void }

function FeedRow({ item, live, opened, setOpen }: { item: FeedItem; live: boolean } & Opened) {
  if (item.type === 'entry') return <FeedEntry entry={item.entry} />
  if (item.type === 'tool') return <ToolRow call={item.call} opened={opened} setOpen={setOpen} />
  return <ToolRun runKey={item.key} calls={item.calls} live={live} opened={opened} setOpen={setOpen} />
}

/** One tool call and its result: the call on one line; open it for the whole call and its output. */
function ToolRow({ call, opened, setOpen }: { call: ToolCall } & Opened) {
  const open = opened.has(call.use.id)
  const failed = call.result?.kind === 'error'
  const callText = revealHidden(call.use.text)
  return (
    <div className={`entry feed-tool ${failed ? 'feed-tool-err' : ''}`}>
      <button className="tool-line" aria-expanded={open} title={callText.slice(0, 2000)} onClick={() => setOpen([call.use.id], !open)}>
        <span className="dv-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-text">{callText}</span>
        {call.result ? (
          <span className={`small ${failed ? 'err' : 'muted'}`}>{failed ? 'error' : sizeLabel(call.result)}</span>
        ) : (
          <span className="small muted">no output</span>
        )}
      </button>
      {open && (
        <div className="tool-detail">
          <div className="entry-text tool-call-full">{callText}</div>
          {call.result && <div className={`entry-text tool-output ${failed ? 'err' : ''}`}>{revealCodeHidden(call.result.text)}</div>}
          <span className="small muted">{new Date(call.use.ts).toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}

/** Three or more tool calls in a row, folded to one line. The newest call shows while the agent is working on it. */
function ToolRun({ runKey, calls, live, opened, setOpen }: { runKey: string; calls: ToolCall[]; live: boolean } & Opened) {
  // Open when you opened it, or opened one of its calls before they folded together. In that case the run
  // itself is marked open too, so closing that call's details doesn't fold the whole run away.
  const viaCall = !opened.has(runKey) && calls.some((c) => opened.has(c.use.id))
  useEffect(() => {
    if (viaCall) setOpen([runKey], true)
  }, [viaCall, runKey, setOpen])
  const open = opened.has(runKey) || viaCall
  const errors = calls.filter((c) => c.result?.kind === 'error').length
  const last = calls[calls.length - 1]!
  return (
    <div className="entry feed-run">
      <button className="tool-line" aria-expanded={open} onClick={() => (open ? setOpen([runKey, ...calls.map((c) => c.use.id)], false) : setOpen([runKey], true))}>
        <span className="dv-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <strong className="small">{calls.length} tool calls</strong>
        <span className="tool-text muted">{runSummary(calls)}</span>
        {errors > 0 && (
          <span className="tag tag-err">
            {errors} error{errors === 1 ? '' : 's'}
          </span>
        )}
      </button>
      {open ? (
        <div className="tool-run-list">
          {calls.map((c) => (
            <ToolRow key={c.use.id} call={c} opened={opened} setOpen={setOpen} />
          ))}
        </div>
      ) : (
        live && <div className="tool-latest muted small">{revealHidden(last.use.text)}</div>
      )}
    </div>
  )
}

function FeedEntry({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false)
  const long = entry.kind === 'tool_result' && entry.text.length > 240
  const text = long && !open ? entry.text.slice(0, 240) + '…' : entry.text
  return (
    <div className={`entry entry-${entry.kind}`} title={new Date(entry.ts).toLocaleString()}>
      {entry.kind === 'user' && <span className="entry-tag">You · {timeAgo(entry.ts)}</span>}
      {/* Characters that make text read differently from what it is (bidi controls, invisible ones) are shown as ⟦U+…⟧. */}
      <div className="entry-text">{revealCodeHidden(text)}</div>
      {long && (
        <button className="link small" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
