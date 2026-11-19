import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MarkerType,
  useReactFlow, type Connection, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FlowNode, type FlowNodeData } from './FlowNode'
import { DataEdge } from './DataEdge'
import { useStore } from '../store'
import type { WorkflowConnection } from '../types'

const nodeTypes = { flow: FlowNode }
const edgeTypes = { data: DataEdge }

function toFlowConnections(connections: WorkflowConnection[]) {
  return connections.map((c, i) => ({
    id: `e_${i}_${c.source}_${c.target}`,
    source: c.source,
    sourceHandle: `out-${c.sourceOutput}`,
    target: c.target,
    targetHandle: `in-${c.targetInput}`,
    type: 'data',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  }))
}

function fromFlowConnection(conn: Connection): WorkflowConnection | null {
  if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return null
  return {
    source: conn.source,
    sourceOutput: Number(conn.sourceHandle.replace('out-', '') || 0),
    target: conn.target,
    targetInput: Number(conn.targetHandle.replace('in-', '') || 0),
  }
}

function CanvasInner() {
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow()
  const workflow = useStore((s) => s.workflow)
  const dirty = useStore((s) => s.dirty)
  const selectedNodeId = useStore((s) => s.selectedNodeId)
  const addNode = useStore((s) => s.addNode)
  const onConnectionsChange = useStore((s) => s.onConnectionsChange)
  const select = useStore((s) => s.select)
  const wrapper = useRef<HTMLDivElement>(null)

  const flowNodes = useMemo(
    () =>
      workflow.nodes.map((n) => ({
        id: n.id,
        type: 'flow' as const,
        position: n.position,
        // Selection is store-driven and used only for the visual highlight.
        // React Flow's own selection events are deliberately ignored (see
        // onPaneClick) to avoid a feedback loop: node click → store select →
        // new nodes array → RF setNodes → onSelectionChange → store select…
        selected: n.id === selectedNodeId,
        draggable: true,
        data: {
          nodeId: n.id,
          nodeType: n.type,
          nodeName: n.name,
          parameters: n.parameters,
          disabled: n.disabled,
        } satisfies FlowNodeData,
      })),
    [workflow.nodes, selectedNodeId],
  )

  const flowEdges = useMemo(() => toFlowConnections(workflow.connections), [workflow.connections])

  // Keep newly added nodes on screen (matters most on narrow viewports).
  const nodeCount = workflow.nodes.length
  const prevCount = useRef(nodeCount)
  useEffect(() => {
    if (nodeCount > prevCount.current) {
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 250, maxZoom: 1 }))
    }
    prevCount.current = nodeCount
  }, [nodeCount, fitView])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/flowops-node')
      if (!type) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addNode(type, { x: position.x - 110, y: position.y - 40 })
    },
    [screenToFlowPosition, addNode],
  )

  const handleNodesChange = (changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position && change.dragging === false) {
        useStore.getState().updateNode(change.id, { position: change.position })
      } else if (change.type === 'remove') {
        useStore.getState().deleteNode(change.id)
      }
    }
  }

  return (
    <div className="relative min-w-0 flex-1" ref={wrapper}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onConnect={(conn) => {
          const mapped = fromFlowConnection(conn)
          if (!mapped) return
          const filtered = workflow.connections.filter(
            (c) => !(c.source === mapped.source && c.sourceOutput === mapped.sourceOutput && c.target === mapped.target && c.targetInput === mapped.targetInput),
          )
          onConnectionsChange([...filtered, mapped])
        }}
        onPaneClick={() => select(null)}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={onDrop}
        onEdgeDoubleClick={(_e, edge) => {
          onConnectionsChange(
            workflow.connections.filter((c) => !(c.source === edge.source && edge.sourceHandle?.startsWith(`out-${c.sourceOutput}`) && c.target === edge.target)),
          )
        }}
        deleteKeyCode={['Delete']}
        defaultEdgeOptions={{ type: 'data', markerEnd: { type: MarkerType.ArrowClosed } }}
        fitView
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        nodesDraggable
        className={dirty ? '[&_.react-flow__edge]:opacity-95' : undefined}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="#2c2d33" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      {workflow.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <p className="text-[15px] font-semibold">Start with a trigger</p>
          <p className="mt-1 max-w-xs text-ink-faint">
            Open the <span className="text-accent">+ Node</span> drawer and drag a trigger onto the canvas, then
            chain steps together.
          </p>
        </div>
      )}

      {/* bottom floating bar */}
      <BottomBar
        onZoomIn={() => zoomIn()}
        onZoomOut={() => zoomOut()}
        onFit={() => fitView({ padding: 0.2, duration: 250 })}
      />
    </div>
  )
}

function BottomBar({ onZoomIn, onZoomOut, onFit }: { onZoomIn: () => void; onZoomOut: () => void; onFit: () => void }) {
  const testWorkflow = useStore((s) => s.testWorkflow)
  const logsOpen = useStore((s) => s.logsOpen)
  const setLogsOpen = useStore((s) => s.setLogsOpen)
  const nodeCount = useStore((s) => s.workflow.nodes.length)
  const runError = useStore((s) => s.runError)

  return (
    <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-surface/95 px-2 py-1.5 shadow-xl backdrop-blur">
      <button
        onClick={testWorkflow}
        disabled={nodeCount === 0}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-accent-strong disabled:opacity-40"
      >
        <Play14 /> Test Workflow
      </button>
      <span className="mx-1 h-5 w-px bg-line" />
      <button onClick={onZoomIn} className="toolbar-mini" title="Zoom in">+</button>
      <button onClick={onZoomOut} className="toolbar-mini" title="Zoom out">−</button>
      <button onClick={onFit} className="toolbar-mini" title="Fit view">⤢</button>
      <button onClick={() => tidyUp()} className="toolbar-mini" title="Tidy up layout">✦</button>
      <span className="mx-1 h-5 w-px bg-line" />
      <button
        onClick={() => setLogsOpen(!logsOpen)}
        className={`toolbar-mini ${logsOpen ? 'text-accent' : ''}`}
        title="Execution logs"
      >
        ☰
      </button>
      {runError && <span className="ml-1 max-w-[220px] truncate text-[11px] text-err">{runError}</span>}
    </div>
  )
}

function Play14() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

/** Simple layered auto-layout: BFS depth → columns. */
function tidyUp() {
  const { workflow, updateNode } = useStore.getState()
  const depth = new Map<string, number>()
  const roots = workflow.nodes.filter((n) => !workflow.connections.some((c) => c.target === n.id))
  for (const r of roots) depth.set(r.id, 0)
  let changed = true
  while (changed) {
    changed = false
    for (const c of workflow.connections) {
      const d = depth.get(c.source)
      if (d !== undefined && (depth.get(c.target) ?? -1) < d + 1) {
        depth.set(c.target, d + 1)
        changed = true
      }
    }
  }
  const byDepth = new Map<number, string[]>()
  for (const n of workflow.nodes) {
    const d = depth.get(n.id) ?? 0
    byDepth.set(d, [...(byDepth.get(d) ?? []), n.id])
  }
  for (const [d, ids] of byDepth) {
    ids.forEach((id, i) => {
      updateNode(id, { position: { x: d * 280, y: i * 140 } })
    })
  }
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
