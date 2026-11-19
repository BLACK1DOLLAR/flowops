import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { AlertTriangle, Check, Hourglass, Pin, SkipForward } from 'lucide-react'
import { NODE_TYPES, outputCount, outputLabels, paramSummary } from '../registry'
import type { NodeSettings } from '../types'
import { useStore } from '../store'

export interface FlowNodeData extends Record<string, unknown> {
  nodeId: string
  nodeType: string
  nodeName: string
  parameters: Record<string, unknown>
  disabled?: boolean
  settings?: NodeSettings
  pinned?: boolean
}

export type FlowNode = Node<FlowNodeData>

function FlowNodeInner({ id, data, selected }: NodeProps<FlowNode>) {
  const def = NODE_TYPES[data.nodeType]
  const Icon = def?.icon
  const run = useStore((s) => s.nodeRuns[id])
  const openInspector = useStore((s) => s.openInspector)
  const isTrigger = def?.group === 'Triggers'
  const outputs = def ? outputCount(def, data) : 1
  const labels = def ? outputLabels(def, data) : []
  const inputs = def?.inputs ?? 1

  const statusBadge = () => {
    if (!run || run.status === 'idle') return null
    if (run.status === 'running') return <span className="badge bg-accent/15 text-accent">Running</span>
    if (run.status === 'success')
      return (
        <span className="badge bg-ok/15 text-ok inline-flex items-center gap-1">
          <Check size={10} strokeWidth={3} /> {run.durationMs} ms
        </span>
      )
    if (run.status === 'waiting')
      return <span className="badge bg-accent/15 text-accent inline-flex items-center gap-1"><Hourglass size={10} /> Waiting</span>
    if (run.status === 'skipped')
      return <span className="badge bg-surface-3 text-ink-faint inline-flex items-center gap-1"><SkipForward size={10} /> Skipped</span>
    return <span className="badge bg-err/15 text-err inline-flex items-center gap-1"><AlertTriangle size={10} /> Error</span>
  }

  return (
    <div
      onClick={() => openInspector(id)}
      className={`w-[220px] cursor-pointer rounded-lg border bg-surface transition-colors
        ${selected ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'border-line hover:border-line-strong'}
        ${run?.status === 'running' ? 'node-running' : ''}`}
    >
      {inputs > 0 && <Handle type="target" id="in-0" position={Position.Left} aria-label={`${data.nodeName} input`} tabIndex={0} />}
      {inputs > 1 && (
        <>
          <Handle type="target" id="in-1" position={Position.Left} style={{ bottom: 14, top: 'auto' }} aria-label={`${data.nodeName} input 2`} tabIndex={0} />
          <span className="absolute -left-1 bottom-[6px] text-[9px] text-ink-faint" style={{ left: -2 }}>2</span>
        </>
      )}

      {Array.from({ length: outputs }).map((_, i) => (
        <Handle
          key={i}
          type="source"
          id={`out-${i}`}
          position={Position.Right}
          className={labels[i] ? `handle-out-${labels[i]}` : undefined}
          style={outputs > 1 ? { top: 'auto', bottom: 16 + (outputs - 1 - i) * 24 } : undefined}
          aria-label={`${data.nodeName} output ${labels[i] || i + 1}`}
          tabIndex={0}
        />
      ))}

      <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-2">
        <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-md border ${
          isTrigger ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface-2 text-ink-dim'
        }`}>
          {Icon && <Icon size={14} strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight">{data.nodeName}</div>
          <div className="truncate text-[10.5px] text-ink-faint leading-tight">{def?.name ?? data.nodeType}</div>
        </div>
        {data.pinned && <span title="Output is pinned — manual runs use the pinned data" className="text-accent"><Pin size={11} /></span>}
        {data.disabled && <span className="text-[9px] font-semibold text-ink-faint border border-line rounded px-1">OFF</span>}
      </div>

      {paramSummary(data.nodeType, data.parameters) && (
        <div className="px-3 pb-2 text-[10.5px] font-mono text-ink-dim truncate">
          {paramSummary(data.nodeType, data.parameters)}
        </div>
      )}

      {outputs > 1 && labels.some(Boolean) && (
        <div className="flex justify-end gap-1 px-3 pb-1.5">
          {labels.map((l, i) => (
            <span key={i} className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${l === 'error' ? 'bg-err/15 text-err' : 'bg-surface-3 text-ink-faint'}`}>{l || i + 1}</span>
          ))}
        </div>
      )}

      {run?.error && (
        <div className="mx-2.5 mb-2 rounded bg-err/10 px-2 py-1 text-[10px] text-err line-clamp-2">{run.error}</div>
      )}

      <div className="flex items-center justify-between border-t border-line px-3 py-1.5">
        <span className="text-[9.5px] text-ink-faint uppercase tracking-wide">{isTrigger ? 'Trigger' : def?.group ?? ''}</span>
        {statusBadge()}
      </div>
    </div>
  )
}

export const FlowNode = memo(FlowNodeInner)
