import { memo } from 'react'
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps,
} from '@xyflow/react'
import { useStore, edgeKey } from '../store'

function DataEdgeInner({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, source, sourceHandleId, target, style }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const edgeItems = useStore((s) => s.edgeItems)
  const hasRunning = useStore((s) => Object.values(s.nodeRuns).some((r) => r.status === 'running'))
  const workflowConns = useStore((s) => s.workflow.connections)

  // Match this rendered edge to its workflow connection for item counts.
  const conn = workflowConns.find((c) => c.source === source && c.target === target)
  const outIdx = Number(sourceHandleId?.replace('out-', '') ?? 0)
  const key = conn ? edgeKey(source, outIdx, target, conn.targetInput ?? 0) : ''
  const count = key ? edgeItems[key] : undefined

  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      <EdgeLabelRenderer>
        {count !== undefined && count > 0 && (
          <div
            className="nodrag nopan absolute rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-dim"
            style={{ transform: 'translate(-50%, -50%)', left: labelX, top: labelY }}
          >
            {count} item{count === 1 ? '' : 's'}
          </div>
        )}
        {hasRunning && count !== undefined && (
          <div
            className="nodrag nopan absolute h-1.5 w-1.5 rounded-full bg-accent"
            style={{ transform: 'translate(-50%, -50%)', left: labelX, top: labelY, animation: 'nodepulse 1s infinite' }}
          />
        )}
      </EdgeLabelRenderer>
    </>
  )
}

export const DataEdge = memo(DataEdgeInner)
