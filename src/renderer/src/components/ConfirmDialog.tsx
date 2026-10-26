import { answerConfirm, useStore } from '../store'
import { Button, Modal } from './ui'

/** Hangar's confirmation dialog (opened with confirmDialog() from the store). */
export function ConfirmDialog() {
  const req = useStore((s) => s.confirm)
  if (!req) return null
  return (
    <Modal
      key={req.id}
      title={req.title}
      onClose={() => answerConfirm(false)}
      footer={
        <>
          <span className="spacer" />
          {/* Cancel comes first and takes focus for anything destructive, so Enter never deletes by accident. */}
          <Button tone="ghost" autoFocus={req.tone === 'danger'} onClick={() => answerConfirm(false)}>
            Cancel
          </Button>
          <Button tone={req.tone} autoFocus={req.tone !== 'danger'} onClick={() => answerConfirm(true)}>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-body">
        {req.body && <p>{req.body}</p>}
        {req.lines && req.lines.length > 0 && (
          <ul className="confirm-lines">
            {req.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
