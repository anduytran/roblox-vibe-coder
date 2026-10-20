import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentState, LogEntry, Project, Role } from '@shared/types'
import { attempt, EMPTY_AGENTS, EMPTY_ROLES, refreshProjects, setRoles, toast, useStore } from '../store'
import { ApprovalCard } from './ApprovalCard'
import { RoleEditor } from './RoleEditor'
import { Button, StatusPill, timeAgo, usd } from './ui'

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
  const [selected, setSelected] = useState('main')
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
            <button key={r.id} className={`agent-card ${selected === r.id ? 'agent-card-active' : ''}`} onClick={() => setSelected(r.id)}>
              <div className="agent-card-top">
                <span className="agent-name">{r.name}</span>
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

function AgentPanel(props: { project: Project; role: Role; state: AgentState | undefined; onEdit?: () => void }) {
  const { project, role, state } = props
  const allApprovals = useStore((s) => s.approvals)
  const approvals = useMemo(() => allApprovals.filter((a) => a.projectId === project.id && a.agentId === role.id), [allApprovals, project.id, role.id])
  const [draft, setDraft] = useState('')
  const [record, setRecord] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const log = state?.log ?? []
  const busy = state?.status === 'working' || state?.status === 'awaiting_approval'

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log.length, approvals.length])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void attempt(() => window.hangar.agents.send(project.id, role.id, text, { record }))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <div className="row gap-sm">
            <h2>{role.name}</h2>
            <StatusPill status={state?.status ?? 'idle'} />
          </div>
          <p className="muted small">{role.description}</p>
        </div>
        <div className="row gap-xs">
          {props.onEdit && (
            <Button size="sm" tone="ghost" onClick={props.onEdit}>
              Edit role
            </Button>
          )}
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
          <div className="feed-empty">
            <p>Give {role.name} a task. Small, specific requests work best, for example:</p>
            <code>Add a 3-second cooldown to the dash augment and playtest it.</code>
          </div>
        )}
        {log.map((e) => (
          <FeedEntry key={e.id} entry={e} />
        ))}
        {approvals.map((a) => (
          <ApprovalCard key={a.id} request={a} onDecided={(d) => d === 'always' && void refreshProjects()} />
        ))}
        {state?.activity && busy && approvals.length === 0 && <div className="activity">{state.activity}</div>}
      </div>

      {state && state.queue.length > 0 && (
        <div className="queue">
          <div className="row between">
            <span className="side-label">Up next ({state.queue.length})</span>
            <button className="link" onClick={() => void attempt(() => window.hangar.agents.clearQueue(project.id, role.id))}>
              Clear queue
            </button>
          </div>
          <ol>
            {state.queue.map((q) => (
              <li key={q.id} title={q.prompt}>
                {q.prompt}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? `Queue another task for ${role.name}…` : `Message ${role.name}…`}
          rows={3}
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
            {project.settings.robloxStudioMcp ? ' · Roblox Studio tools on' : ''}
            {project.settings.sandbox && (window.hangar.platform === 'darwin' || window.hangar.platform === 'linux') ? ' · Sandboxed' : ' · Not sandboxed'}
          </span>
          {project.settings.robloxStudioMcp && (
            <label className="record-check" title="Record a short clip of the agent's playtest for the review">
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} /> Record playtest
            </label>
          )}
          <Button tone="primary" disabled={!draft.trim()} onClick={send}>
            {busy ? 'Queue' : 'Send'}
          </Button>
        </div>
      </div>
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
      <div className="entry-text">{text}</div>
      {long && (
        <button className="link small" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
