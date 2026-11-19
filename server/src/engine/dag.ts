import type {
  ExecutionMode,
  Item,
  NodeRun,
  Store,
  WorkflowNode,
  WorkflowRecord,
  Connection,
} from '../store/types.js'
import { getNodeHandler } from './nodes.js'

export interface RunParams {
  workflow: WorkflowRecord
  mode: ExecutionMode
  trigger?: { nodeId?: string; type?: string; payload?: unknown }
  inputItems?: Item[]
}

export interface RunResult {
  status: 'success' | 'error'
  nodeRuns: NodeRun[]
  itemsByEdge: Record<string, number>
  error?: string
}

const MAX_STEPS = 500
const MAX_SNAPSHOT_CHARS = 12000

function trim<T>(items: T, maxChars = MAX_SNAPSHOT_CHARS): T {
  try {
    const s = JSON.stringify(items)
    if (s.length <= maxChars) return items
    return JSON.parse(s.slice(0, maxChars))
  } catch {
    return items
  }
}

const TRIGGER_TYPES = new Set(['manualTrigger', 'schedule', 'webhook'])

function startNodes(workflow: WorkflowRecord, triggerNodeId?: string, mode?: ExecutionMode): string[] {
  if (triggerNodeId) return [triggerNodeId]
  if (mode === 'manual' || mode === 'test') {
    const manual = workflow.nodes.filter((n) => n.type === 'manualTrigger')
    if (manual.length > 0) return manual.map((n) => n.id)
  }
  const withIncoming = new Set(workflow.connections.map((c) => c.target))
  const roots = workflow.nodes.filter((n) => !withIncoming.has(n.id))
  // Start from trigger nodes only. A non-trigger node with nothing wired into
  // it is a disconnected node, not an entry point — running it would hide the
  // missing connection. Workflows with no trigger at all (quick experiments)
  // still fall back to running every root.
  const triggerRoots = roots.filter((n) => TRIGGER_TYPES.has(n.type))
  return (triggerRoots.length > 0 ? triggerRoots : roots).map((n) => n.id)
}

/**
 * DAG execution engine. Standardized items (`[{ json, binary }]`) flow along
 * connections. Each edge delivers exactly once; a node runs when all of its
 * incoming edges have delivered (a node that received only empty payloads is
 * skipped and its own edges deliver empty payloads, closing the graph).
 * Conditional nodes deliver items only to branch outputs that matched.
 */
export async function executeWorkflow(store: Store, params: RunParams): Promise<RunResult> {
  const { workflow, mode, trigger } = params
  const nodesById = new Map<string, WorkflowNode>(workflow.nodes.map((n) => [n.id, n]))
  const connections: Connection[] = workflow.connections

  const incomingByNode = new Map<string, Connection[]>()
  for (const c of connections) {
    const list = incomingByNode.get(c.target) ?? []
    list.push(c)
    incomingByNode.set(c.target, list)
  }

  const edgeKey = (c: Connection) => `${c.source}:${c.sourceOutput}:${c.target}:${c.targetInput}`

  const deliveredInputs = new Map<string, Item[][]>() // nodeId -> items per input index
  const deliveredEdges = new Set<string>() // edgeKeys that have delivered
  const itemsByEdge: Record<string, number> = {}
  const nodeRuns: NodeRun[] = []
  let status: 'success' | 'error' = 'success'
  let firstError: string | undefined

  const ready: string[] = startNodes(workflow, trigger?.nodeId, mode)
  const queued = new Set(ready)
  const processed = new Set<string>()
  let steps = 0

  const deliver = (c: Connection, items: Item[]) => {
    deliveredEdges.add(edgeKey(c))
    const perInput = deliveredInputs.get(c.target) ?? []
    perInput[c.targetInput] = [...(perInput[c.targetInput] ?? []), ...items]
    deliveredInputs.set(c.target, perInput)
    itemsByEdge[edgeKey(c)] = (itemsByEdge[edgeKey(c)] ?? 0) + items.length

    const all = incomingByNode.get(c.target) ?? []
    const allDelivered = all.every((e) => deliveredEdges.has(edgeKey(e)))
    if (allDelivered && !queued.has(c.target) && !processed.has(c.target)) {
      queued.add(c.target)
      ready.push(c.target)
    }
  }

  const propagate = (sourceId: string, outputs: Item[][] | null) => {
    for (const c of connections.filter((e) => e.source === sourceId)) {
      const idx = c.sourceOutput ?? 0
      deliver(c, outputs ? outputs[idx] ?? [] : [])
    }
  }

  while (ready.length > 0 && steps < MAX_STEPS) {
    steps++
    const id = ready.shift()!
    if (processed.has(id)) continue
    processed.add(id)

    const node = nodesById.get(id)
    if (!node) continue

    const perInput = deliveredInputs.get(id) ?? []
    const incomingEdges = incomingByNode.get(id) ?? []
    const items: Item[] = perInput.flat()
    const hasIncoming = incomingEdges.length > 0

    if (node.disabled) {
      nodeRuns.push({
        nodeId: id, nodeName: node.name, nodeType: node.type, status: 'skipped',
        startedAt: new Date().toISOString(), durationMs: 0, input: trim(items.slice(0, 50)), output: [],
      })
      propagate(id, [items]) // disabled nodes pass items through
      continue
    }

    if (hasIncoming && items.length === 0) {
      nodeRuns.push({
        nodeId: id, nodeName: node.name, nodeType: node.type, status: 'skipped',
        startedAt: new Date().toISOString(), durationMs: 0, input: [], output: [],
      })
      propagate(id, []) // dead branch — keep the graph closed
      continue
    }

    const startedAt = new Date()
    const logs: string[] = []
    const run: NodeRun = {
      nodeId: id,
      nodeName: node.name,
      nodeType: node.type,
      status: 'success',
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      input: trim(items.slice(0, 50)),
      output: [],
    }

    try {
      const handler = getNodeHandler(node.type)
      const outputs = await handler({
        node: structuredClone(node),
        items,
        inputs: perInput,
        trigger: trigger?.nodeId === id ? trigger.payload : undefined,
        mode,
        logs,
        getCredential: async (credId) => {
          const cred = await store.getCredential(credId)
          return cred ? { type: cred.type, data: cred.data } : null
        },
        store,
      })
      run.durationMs = Date.now() - startedAt.getTime()
      run.output = trim(outputs.map((arr) => arr.slice(0, 50)))
      if (logs.length) run.logs = logs
      nodeRuns.push(run)
      propagate(id, outputs)
    } catch (err) {
      run.status = 'error'
      run.durationMs = Date.now() - startedAt.getTime()
      run.error = (err as Error).message ?? String(err)
      nodeRuns.push(run)
      status = 'error'
      firstError ??= `${node.name}: ${run.error}`
      propagate(id, null)
    }
  }

  // Report nodes that aren't wired to any trigger, instead of silently leaving
  // them out, so the canvas and logs show what's missing. Nodes that belong to
  // another trigger's branch (e.g. a second webhook) are not reported.
  const reachable = new Set<string>(startNodes(workflow))
  const stack = [...reachable]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of connections) {
      if (c.source === id && !reachable.has(c.target)) {
        reachable.add(c.target)
        stack.push(c.target)
      }
    }
  }
  for (const node of workflow.nodes) {
    if (processed.has(node.id) || reachable.has(node.id) || TRIGGER_TYPES.has(node.type)) continue
    nodeRuns.push({
      nodeId: node.id, nodeName: node.name, nodeType: node.type, status: 'skipped',
      startedAt: new Date().toISOString(), durationMs: 0, input: [], output: [],
      error: 'Not connected to a trigger, so it did not run. Wire it to the trigger or an upstream node.',
    })
  }

  return { status, nodeRuns, itemsByEdge, error: firstError }
}
