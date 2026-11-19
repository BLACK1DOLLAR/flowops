import { useEffect, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import type { WorkflowVersionSummary } from '../types'

/** Saved versions of the current workflow, newest first, with one-click restore. */
export function HistoryPanel() {
  const open = useStore((s) => s.historyOpen)
  const setOpen = useStore((s) => s.setHistoryOpen)
  const workflowId = useStore((s) => s.workflow.id)
  const updatedAt = useStore((s) => (s.workflow as { updatedAt?: string }).updatedAt)
  const dirty = useStore((s) => s.dirty)
  const restoreVersion = useStore((s) => s.restoreVersion)
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !workflowId) return
    api.versions(workflowId).then(setVersions, (err: Error) => setError(err.message))
  }, [open, workflowId, updatedAt])

  if (!open) return null

  const restore = async (v: WorkflowVersionSummary) => {
    if (dirty && !confirm('You have unsaved changes. Restoring replaces them — continue?')) return
    setBusy(v.id)
    setError(null)
    try {
      await restoreVersion(v.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="slide-in absolute bottom-4 right-4 top-4 z-30 flex w-[300px] flex-col rounded-xl border border-line bg-surface shadow-2xl" aria-label="Version history">
      <div className="flex items-center border-b border-line px-3 py-2.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">Version history</span>
        <button onClick={() => setOpen(false)} className="ml-auto rounded p-1 text-ink-faint hover:text-ink" aria-label="Close version history">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && <p className="p-2 text-[11.5px] text-err">{error}</p>}
        {versions.length === 0 && !error && <p className="p-3 text-[11.5px] text-ink-faint">Each save adds a version here.</p>}
        {versions.map((v, i) => (
          <div key={v.id} className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium">
                {new Date(v.createdAt).toLocaleString()} {i === 0 && <span className="ml-1 text-[10px] text-ok">current</span>}
              </div>
              <div className="truncate text-[10.5px] text-ink-faint">{v.name} · {v.nodeCount} nodes</div>
            </div>
            {i > 0 && (
              <button
                onClick={() => restore(v)}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] text-ink-dim hover:border-accent hover:text-accent disabled:opacity-40"
              >
                <RotateCcw size={11} /> {busy === v.id ? '…' : 'Restore'}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-line px-3 py-2 text-[10.5px] text-ink-faint">The newest 50 versions are kept. Restoring saves a new version, so it can be undone.</p>
    </aside>
  )
}
