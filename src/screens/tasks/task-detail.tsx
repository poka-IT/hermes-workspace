import { useEffect, useState } from 'react'
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ClaudeTask } from '@/lib/tasks-api'
import { COLUMN_COLORS, COLUMN_LABELS } from '@/lib/tasks-api'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: ClaudeTask | null
  assigneeLabel: string | null
  onRespond: (message: string) => Promise<void>
  onUnblock: () => Promise<void>
  onEdit: () => void
  isResponding: boolean
  isUnblocking: boolean
}

export function TaskDetail({
  open,
  onOpenChange,
  task,
  assigneeLabel,
  onRespond,
  onUnblock,
  onEdit,
  isResponding,
  isUnblocking,
}: Props) {
  const [reply, setReply] = useState('')

  useEffect(() => {
    if (open) setReply('')
  }, [open, task?.id])

  if (!task) return null

  // The block reason / completion summary the worker left behind. For a blocked
  // card this is the WHY; for a gave-up run, latest_run_outcome explains the
  // crash. Either is the thing the old UI threw away.
  const summary = task.latest_run_summary?.trim() || ''
  const outcome = task.latest_run_outcome?.trim() || ''
  const hasRun = Boolean(summary || outcome)
  const isActionable = task.column === 'blocked' || task.column === 'review'
  const colColor = COLUMN_COLORS[task.column]

  async function handleRespond() {
    const message = reply.trim()
    if (!message) return
    await onRespond(message)
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,95vw)] border-[var(--theme-border)] bg-[var(--theme-bg)] overflow-hidden">
        <div className="h-[3px] w-full" style={{ background: colColor }} />

        <div className="flex max-h-[85vh] flex-col p-5">
          <div className="mb-1 flex items-start justify-between gap-3">
            <DialogTitle className="text-base font-semibold text-[var(--theme-text)]">
              {task.title}
            </DialogTitle>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: `${colColor}22`, color: colColor }}
            >
              {COLUMN_LABELS[task.column]}
            </span>
          </div>
          <DialogDescription className="mb-4 text-xs text-[var(--theme-muted)]">
            {assigneeLabel ? `Assigné à ${assigneeLabel}` : 'Non assigné'}
            {' · '}
            {task.id}
          </DialogDescription>

          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {/* Worker outcome — the block reason / latest run summary */}
            {hasRun && (
              <div
                className={cn(
                  'rounded-lg border p-3',
                  task.column === 'blocked'
                    ? 'border-red-500/50 bg-red-500/5'
                    : 'border-[var(--theme-border)] bg-[var(--theme-card)]',
                )}
              >
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                  {task.column === 'blocked'
                    ? 'Raison du blocage'
                    : 'Dernier compte-rendu du worker'}
                </p>
                {summary && (
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--theme-text)]">
                    {summary}
                  </p>
                )}
                {outcome && (
                  <p className="mt-2 whitespace-pre-wrap text-[11px] italic leading-relaxed text-[var(--theme-muted)]">
                    {outcome}
                  </p>
                )}
              </div>
            )}

            {/* Original brief */}
            {task.description?.trim() && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                  Brief
                </p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--theme-muted)]">
                  {task.description}
                </p>
              </div>
            )}

            {/* Respond & relaunch — only meaningful for blocked/review cards */}
            {isActionable && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                  Répondre &amp; relancer
                </p>
                <textarea
                  className={cn(
                    'w-full resize-none rounded-lg border px-3 py-2 text-sm',
                    'bg-[var(--theme-input)] border-[var(--theme-border)] text-[var(--theme-text)]',
                    'focus:outline-none focus:ring-1 focus:ring-[var(--theme-accent)]',
                    'placeholder:text-[var(--theme-muted)]',
                  )}
                  rows={4}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Ta décision / consigne — elle est ajoutée au brief et un nouveau worker repart avec…"
                />
                <p className="mt-1 text-[10px] text-[var(--theme-muted)]">
                  Envoyer remet la carte en file (Ready) et relance un worker avec ta réponse en contexte.
                </p>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--theme-border)] pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              Éditer
            </Button>
            <div className="flex gap-2">
              {isActionable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onUnblock()}
                  disabled={isUnblocking || isResponding}
                >
                  {isUnblocking ? '…' : 'Débloquer'}
                </Button>
              )}
              {isActionable ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleRespond()}
                  disabled={isResponding || isUnblocking || !reply.trim()}
                  style={{ background: 'var(--theme-accent)', color: 'white' }}
                >
                  {isResponding ? 'Envoi…' : 'Répondre & relancer'}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  style={{ background: 'var(--theme-accent)', color: 'white' }}
                >
                  Fermer
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
