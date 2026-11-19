import { useEffect, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'

export function LogsDrawer() {
  const open = useStore((s) => s.logsOpen)
  const setOpen = useStore((s) => s.setLogsOpen)
  const executions = useStore((s) => s.executions)
  const workflowId = useStore((s) => s.workflow.id)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, { nodeCount: number; runs: Array<{ nodeName: string; status: string; durationMs: number; error?: string }> }>>({})

  useEffect(() => {
    if (open) useStore.getState().loadExecutions()
  }, [open, workflowId])

  const expand = async (id: string) => {
    if (expandedId === id) return setExpandedId(null)
    setExpandedId(id)
    if (!detail[id]) {
      const exec = await api.execution(id)
      setDetail((d) => ({
        ...d,
        [id]: {
          nodeCount: exec.nodeRuns.length,
          runs: exec.nodeRuns.map((n) => ({ nodeName: n.nodeName, status: n.status, durationMs: n.durationMs, error: n.error?.slice(0, 140) })),
        },
      }))
    }
  }

  const replay = async (id: string) => {
    await api.replay(id)
    await useStore.getState().loadExecutions()
  }

  return (
    <section
      className={`absolute bottom-16 left-3 right-3 z-20 max-h-[300px] rounded-xl border border-line bg-surface shadow-2xl transition-all ${
        open ? 'flex flex-col' : 'hidden'
      }`}
      aria-label="Execution logs"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">Execution Logs</span>
        <span className="text-[10.5px] text-ink-faint">{executions.length} runs</span>
        <button onClick={() => setOpen(false)} className="ml-auto rounded p-1 text-ink-faint hover:text-ink" aria-label="Close logs">
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {executions.length === 0 && <p className="p-3 text-[11.5px] text-ink-faint">No executions yet — hit Test Workflow.</p>}
        {executions.map((e) => (
          <div key={e.id} className="mb-1 rounded-lg border border-line bg-surface-2">
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => expand(e.id)}>
              <span className={`h-2 w-2 flex-none rounded-full ${e.status === 'success' ? 'bg-ok' : e.status === 'error' ? 'bg-err' : 'bg-ink-faint animate-pulse'}`} />
              <span className="text-[12px] font-medium">{new Date(e.startedAt).toLocaleTimeString()}</span>
              <span className="text-[10.5px] text-ink-faint">{e.mode}</span>
              <span className="text-[11px] text-ink-dim">{e.durationMs ?? 0} ms · {e.nodeCount} nodes</span>
              {e.error && <span className="min-w-0 flex-1 truncate text-[10.5px] text-err">{e.error}</span>}
              <span
                className="ml-auto rounded p-1 text-ink-faint hover:text-accent"
                onClick={(ev) => { ev.stopPropagation(); replay(e.id) }}
                title="Replay execution"
              >
                <RotateCcw size={12} />
              </span>
            </button>
            {expandedId === e.id && detail[e.id] && (
              <div className="border-t border-line px-3 py-2">
                {detail[e.id].runs.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 py-0.5 text-[11px]">
                    <span className={`h-1.5 w-1.5 rounded-full ${r.status === 'success' ? 'bg-ok' : r.status === 'error' ? 'bg-err' : 'bg-ink-faint'}`} />
                    <span className="font-medium">{r.nodeName}</span>
                    <span className="text-ink-faint">{r.durationMs} ms</span>
                    {r.error && <span className="truncate text-err">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
