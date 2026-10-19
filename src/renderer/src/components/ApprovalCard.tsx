import { useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { attempt } from '../store'
import { Button } from './ui'

export function ApprovalCard({ request, onDecided }: { request: ApprovalRequest; onDecided?: (d: ApprovalDecision) => void }) {
  const [showInput, setShowInput] = useState(false)
  const [busy, setBusy] = useState(false)

  const decide = (d: ApprovalDecision): void => {
    setBusy(true)
    void attempt(async () => {
      await window.hangar.approvals.respond(request.id, d)
      onDecided?.(d)
    }).finally(() => setBusy(false))
  }

  const alwaysLabel = request.toolName === 'Bash' ? 'Always allow this command' : `Always allow ${request.toolName.replace(/^mcp__[^_]+__/, '')}`

  return (
    <div className={`approval ${request.outsideProject ? 'approval-danger' : ''}`}>
      <div className="approval-head">
        <strong>{request.outsideProject ? 'Outside the project folder' : 'Approval needed'}</strong>
        <span className="muted small">{request.reason}</span>
      </div>
      <pre className="approval-summary">{request.summary}</pre>
      <button className="link small" onClick={() => setShowInput(!showInput)}>
        {showInput ? 'Hide details' : 'Show full details'}
      </button>
      {showInput && <pre className="approval-input">{request.inputJson}</pre>}
      <div className="row gap-xs">
        <Button tone="primary" size="sm" disabled={busy} onClick={() => decide('allow')}>
          Allow once
        </Button>
        {!request.outsideProject && (
          <Button size="sm" disabled={busy} onClick={() => decide('always')} title="Saved in this project's settings; you can remove it there">
            {alwaysLabel}
          </Button>
        )}
        <Button tone="danger" size="sm" disabled={busy} onClick={() => decide('deny')}>
          Deny
        </Button>
      </div>
    </div>
  )
}
