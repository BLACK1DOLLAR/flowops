import type {
  ExecutionMode,
  Item,
  NodeRun,
  Store,
  WorkflowNode,
  WorkflowRecord,
  Connection,
} from '../store/types.js'
import { getNodeHandler, planWait, type WebhookResponse } from './nodes.js'

export interface RunParams {
  workflow: WorkflowRecord
  mode: ExecutionMode
  trigger?: { nodeId?: string; type?: string; payload?: unknown }
  /** Items fed to the start node(s) when there is no trigger payload (error workflows, replays). */
  inputItems?: Item[]
  /** Id of the execution record, exposed to expressions as $execution.id / $execution.resumeUrl. */
  executionId?: string
  /** Continue a run that paused on a Wait node. */
  resume?: { state: EngineState; data?: unknown }
  /** Called by a "Respond to Webhook" node. */
  onResponse?: (response: WebhookResponse) => void
}

export interface RunResult {
  status: 'success' | 'error' | 'waiting'
  nodeRuns: NodeRun[]
  itemsByEdge: Record<string, number>
  error?: string
  /** For status 'waiting': when to resume (undefined = only via the resume webhook). */
  waitTill?: string
  /** For status 'waiting': state to pass back as `resume.state`. */
  resumeState?: EngineState
}

interface LoopState {
  batches: Item[][]
  index: number
  results: Item[]
  done: boolean
}

/** Everything needed to continue an execution later. JSON-serializable. */
export interface EngineState {
  edgeItems: Record<string, Item[]>
  delivered: string[]
  processed: string[]
  ready: string[]
  loops: Record<string, LoopState>
  nodeRuns: NodeRun[]
  itemsByEdge: Record<string, number>
  runData: Record<string, Item[][]>
  status: 'success' | 'error'
  firstError?: string
  waitingNode?: string
  steps: number
}

const MAX_STEPS = 10000
const MAX_SNAPSHOT_CHARS = 12000
const RUN_DATA_ITEMS = 200
/** Waits up to this long run inline; longer ones pause the execution and resume later. */
export const INLINE_WAIT_MAX_MS = 5000

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

/** Number of regular (non-error) outputs a node has. */
export function normalOutputCount(node: WorkflowNode): number {
  if (node.type === 'if' || node.type === 'loopOverItems') return 2
  if (node.type === 'switch') return ((node.parameters.rules as unknown[] | undefined) ?? []).length + 1
  return 1
}

const edgeKey = (c: Connection) => `${c.source}:${c.sourceOutput}:${c.target}:${c.targetInput}`

interface LoopInfo {
  body: Set<string> // nodes that run once per batch
  backEdges: Set<string> // edge keys from the body back into the loop node
}

/**
 * For every Loop Over Items node: the body is everything reachable from its
 * "loop" output (index 1) without passing back through the loop node, and the
 * back edges are the connections from the body into the loop node.
 */
function analyzeLoops(workflow: WorkflowRecord): Map<string, LoopInfo> {
  const result = new Map<string, LoopInfo>()
  for (const node of workflow.nodes) {
    if (node.type !== 'loopOverItems') continue
    const body = new Set<string>()
    const stack = workflow.connections.filter((c) => c.source === node.id && c.sourceOutput === 1).map((c) => c.target)
    while (stack.length) {
      const id = stack.pop()!
      if (id === node.id || body.has(id)) continue
      body.add(id)
      for (const c of workflow.connections) if (c.source === id) stack.push(c.target)
    }
    const backEdges = new Set(
      workflow.connections.filter((c) => c.target === node.id && body.has(c.source)).map(edgeKey),
    )
    result.set(node.id, { body, backEdges })
  }
  return result
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Execution engine. Items (`[{ json, binary }]`) flow along connections; each
 * edge delivers once per run (or once per loop iteration inside a loop body).
 * A node runs when all of its incoming edges have delivered; a node that
 * received only empty payloads is skipped and its own edges deliver empty
 * payloads, closing the graph. Conditional nodes deliver only to the outputs
 * that matched.
 */
export async function executeWorkflow(store: Store, params: RunParams): Promise<RunResult> {
  const { workflow, mode, trigger } = params
  const nodesById = new Map<string, WorkflowNode>(workflow.nodes.map((n) => [n.id, n]))
  const connections: Connection[] = workflow.connections
  const incomingByNode = new Map<string, Connection[]>()
  const outgoingByNode = new Map<string, Connection[]>()
  for (const c of connections) {
    incomingByNode.set(c.target, [...(incomingByNode.get(c.target) ?? []), c])
    outgoingByNode.set(c.source, [...(outgoingByNode.get(c.source) ?? []), c])
  }
  const loopInfo = analyzeLoops(workflow)
  const loopsContaining = new Map<string, string[]>() // body node -> loop ids
  for (const [loopId, info] of loopInfo) {
    for (const id of info.body) loopsContaining.set(id, [...(loopsContaining.get(id) ?? []), loopId])
  }
  const starts = startNodes(workflow, trigger?.nodeId, mode)
  const startSet = new Set(starts)

  const st: EngineState = params.resume
    ? structuredClone(params.resume.state)
    : {
        edgeItems: {}, delivered: [], processed: [], ready: [...starts], loops: {}, nodeRuns: [],
        itemsByEdge: {}, runData: {}, status: 'success', steps: 0,
      }
  const delivered = new Set(st.delivered)
  const processed = new Set(st.processed)
  const queued = new Set(st.ready)
  const resumingNode = st.waitingNode
  const resumeData = params.resume?.data
  st.waitingNode = undefined
  if (resumingNode) st.nodeRuns = st.nodeRuns.filter((r) => !(r.nodeId === resumingNode && r.status === 'waiting'))

  const allDelivered = (edges: Connection[]) => edges.every((e) => delivered.has(edgeKey(e)))

  const isReady = (id: string): boolean => {
    const incoming = incomingByNode.get(id) ?? []
    const loop = loopInfo.get(id)
    if (!loop) return !processed.has(id) && allDelivered(incoming)
    const ls = st.loops[id]
    if (!ls) return allDelivered(incoming.filter((c) => !loop.backEdges.has(edgeKey(c))))
    if (ls.done) return false
    for (const b of loop.body) if (queued.has(b)) return false // let the current iteration finish first
    return allDelivered(incoming.filter((c) => loop.backEdges.has(edgeKey(c))))
  }

  const enqueueIfReady = (id: string) => {
    if (!queued.has(id) && isReady(id)) {
      queued.add(id)
      st.ready.push(id)
    }
  }

  const deliver = (c: Connection, items: Item[]) => {
    const k = edgeKey(c)
    delivered.add(k)
    st.edgeItems[k] = [...(st.edgeItems[k] ?? []), ...items]
    st.itemsByEdge[k] = (st.itemsByEdge[k] ?? 0) + items.length
    enqueueIfReady(c.target)
  }

  const propagate = (sourceId: string, outputs: Item[][] | null, only?: Set<number>) => {
    for (const c of outgoingByNode.get(sourceId) ?? []) {
      const idx = c.sourceOutput ?? 0
      if (only && !only.has(idx)) continue
      deliver(c, outputs ? outputs[idx] ?? [] : [])
    }
  }

  const inputsFor = (edges: Connection[]): Item[][] => {
    const perInput: Item[][] = []
    for (const c of edges) perInput[c.targetInput] = [...(perInput[c.targetInput] ?? []), ...(st.edgeItems[edgeKey(c)] ?? [])]
    return perInput
  }

  const triggerFor = (id: string): unknown => {
    if (trigger?.nodeId === id) return trigger.payload
    if (!trigger && params.inputItems?.length && startSet.has(id)) return params.inputItems.map((i) => i.json)
    return undefined
  }

  const makeCtx = (node: WorkflowNode, items: Item[], perInput: Item[][], logs: string[]) => ({
    node: structuredClone(node),
    items,
    inputs: perInput,
    trigger: triggerFor(node.id),
    mode,
    logs,
    getCredential: async (credId: string) => {
      const cred = await store.getCredential(credId)
      return cred ? { type: cred.type, data: cred.data } : null
    },
    store,
    executionId: params.executionId,
    runData: st.runData,
    respond: params.onResponse,
  })

  const recordOutputs = (node: WorkflowNode, outputs: Item[][]) => {
    st.runData[node.name] = outputs.map((o) => o.slice(0, RUN_DATA_ITEMS))
  }

  const skippedRun = (node: WorkflowNode, items: Item[]): NodeRun => ({
    nodeId: node.id, nodeName: node.name, nodeType: node.type, status: 'skipped',
    startedAt: new Date().toISOString(), durationMs: 0, input: trim(items.slice(0, 50)), output: [],
  })

  const resetLoopBody = (loopId: string) => {
    const info = loopInfo.get(loopId)!
    for (const c of connections) {
      if (info.body.has(c.source) || (c.source === loopId && c.sourceOutput === 1)) {
        const k = edgeKey(c)
        delivered.delete(k)
        delete st.edgeItems[k]
      }
    }
    for (const id of info.body) {
      processed.delete(id)
      queued.delete(id)
    }
  }

  const runLoopNode = (node: WorkflowNode) => {
    const info = loopInfo.get(node.id)!
    const incoming = incomingByNode.get(node.id) ?? []
    const startedAt = new Date()
    let ls = st.loops[node.id]
    let input: Item[]

    if (!ls) {
      input = inputsFor(incoming.filter((c) => !info.backEdges.has(edgeKey(c)))).flat()
      const size = Math.max(1, Number(node.parameters.batchSize ?? 1) || 1)
      const batches: Item[][] = []
      for (let i = 0; i < input.length; i += size) batches.push(input.slice(i, i + size))
      if (node.disabled || info.backEdges.size === 0) {
        // Nothing loops back: send every item out of both outputs at once.
        st.loops[node.id] = { batches, index: batches.length, results: input, done: true }
        const outputs = [input, input]
        st.nodeRuns.push({
          nodeId: node.id, nodeName: node.name, nodeType: node.type, status: node.disabled ? 'skipped' : 'success',
          startedAt: startedAt.toISOString(), durationMs: 0, input: trim(input.slice(0, 50)), output: trim(outputs.map((o) => o.slice(0, 50))),
        })
        recordOutputs(node, outputs)
        propagate(node.id, outputs)
        return
      }
      ls = { batches, index: 0, results: [], done: false }
      st.loops[node.id] = ls
    } else {
      input = inputsFor(incoming.filter((c) => info.backEdges.has(edgeKey(c)))).flat()
      ls.results.push(...input)
      ls.index++
      resetLoopBody(node.id)
    }

    let outputs: Item[][]
    if (ls.index < ls.batches.length) {
      outputs = [[], ls.batches[ls.index]]
      propagate(node.id, outputs, new Set([1]))
    } else {
      ls.done = true
      outputs = [ls.results, []]
      propagate(node.id, outputs, new Set([0]))
    }
    recordOutputs(node, outputs)
    st.nodeRuns.push({
      nodeId: node.id, nodeName: node.name, nodeType: node.type, status: 'success',
      startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
      input: trim(input.slice(0, 50)), output: trim(outputs.map((o) => o.slice(0, 50))),
      logs: [ls.done ? `done after ${ls.batches.length} batch(es)` : `batch ${ls.index + 1} of ${ls.batches.length}`],
    })
  }

  const finish = (status: RunResult['status'], waitTill?: Date): RunResult => {
    st.delivered = [...delivered]
    st.processed = [...processed]
    if (status === 'waiting') {
      return {
        status, nodeRuns: st.nodeRuns, itemsByEdge: st.itemsByEdge, error: st.firstError,
        waitTill: waitTill?.toISOString(), resumeState: st,
      }
    }
    // Report nodes that aren't wired to any trigger, instead of silently leaving
    // them out, so the canvas and logs show what's missing. Nodes that belong to
    // another trigger's branch (e.g. a second webhook) are not reported.
    const reachable = new Set<string>(startNodes(workflow))
    const stack = [...reachable]
    while (stack.length) {
      const id = stack.pop()!
      for (const c of outgoingByNode.get(id) ?? []) {
        if (!reachable.has(c.target)) {
          reachable.add(c.target)
          stack.push(c.target)
        }
      }
    }
    const ran = new Set(st.nodeRuns.map((r) => r.nodeId))
    for (const node of workflow.nodes) {
      if (ran.has(node.id) || reachable.has(node.id) || TRIGGER_TYPES.has(node.type)) continue
      st.nodeRuns.push({
        ...skippedRun(node, []),
        error: 'Not connected to a trigger, so it did not run. Wire it to the trigger or an upstream node.',
      })
    }
    return { status: st.status, nodeRuns: st.nodeRuns, itemsByEdge: st.itemsByEdge, error: st.firstError }
  }

  while (st.ready.length > 0 && st.steps < MAX_STEPS) {
    st.steps++
    const id = st.ready.shift()!
    queued.delete(id)
    const node = nodesById.get(id)
    if (!node) continue

    if (loopInfo.has(id)) {
      runLoopNode(node)
      continue
    }
    if (processed.has(id)) continue
    processed.add(id)
    const afterNode = () => {
      for (const loopId of loopsContaining.get(id) ?? []) enqueueIfReady(loopId)
    }

    const perInput = inputsFor(incomingByNode.get(id) ?? [])
    const items: Item[] = perInput.flat()
    const hasIncoming = (incomingByNode.get(id) ?? []).length > 0

    if (node.disabled) {
      st.nodeRuns.push(skippedRun(node, items))
      propagate(id, [items]) // disabled nodes pass items through
      afterNode()
      continue
    }
    if (hasIncoming && items.length === 0) {
      st.nodeRuns.push(skippedRun(node, []))
      propagate(id, []) // dead branch — keep the graph closed
      afterNode()
      continue
    }

    const startedAt = new Date()
    const logs: string[] = []
    const run: NodeRun = {
      nodeId: id, nodeName: node.name, nodeType: node.type, status: 'success',
      startedAt: startedAt.toISOString(), durationMs: 0, input: trim(items.slice(0, 50)), output: [],
    }
    const ctx = makeCtx(node, items, perInput, logs)

    // Wait: short waits sleep inline; longer ones (or "until resumed") pause the run.
    if (node.type === 'wait') {
      if (resumingNode === id) {
        const outputs = resumeData !== undefined ? [[{ json: toJson(resumeData) }]] : [items]
        run.output = trim(outputs)
        run.logs = [resumeData !== undefined ? 'resumed by webhook' : 'resumed after wait']
        st.nodeRuns.push(run)
        recordOutputs(node, outputs)
        propagate(id, outputs)
        afterNode()
        continue
      }
      try {
        const plan = planWait(ctx)
        if (plan.persist) {
          processed.delete(id)
          st.ready.unshift(id)
          st.waitingNode = id
          run.status = 'waiting'
          run.logs = [plan.until ? `waiting until ${plan.until.toISOString()}` : 'waiting for the resume webhook']
          st.nodeRuns.push(run)
          return finish('waiting', plan.until)
        }
      } catch (err) {
        run.status = 'error'
        run.error = (err as Error).message
        st.nodeRuns.push(run)
        st.status = 'error'
        st.firstError ??= `${node.name}: ${run.error}`
        propagate(id, null)
        afterNode()
        continue
      }
    }

    const settings = node.settings ?? {}
    const onError = settings.onError ?? 'stop'
    const pinned = node.pinData && (mode === 'manual' || mode === 'test')
    const maxTries = settings.retryOnFail && !pinned ? Math.min(10, Math.max(1, Number(settings.maxTries ?? 3))) : 1
    const waitBetween = Math.min(60000, Math.max(0, Number(settings.waitBetweenTries ?? 1000)))

    let outputs: Item[][] | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        outputs = pinned ? [structuredClone(node.pinData!)] : await getNodeHandler(node.type)(ctx)
        if (pinned) logs.push('[pinned] returned pinned data instead of running')
        if (attempt > 1) logs.push(`[retry] succeeded on attempt ${attempt}`)
        break
      } catch (err) {
        lastError = err
        if (attempt < maxTries) {
          logs.push(`[retry] attempt ${attempt} failed: ${(err as Error).message}`)
          await sleep(waitBetween)
        }
      }
    }
    run.durationMs = Date.now() - startedAt.getTime()
    if (logs.length) run.logs = logs
    const normal = normalOutputCount(node)

    if (outputs) {
      if (onError === 'errorOutput') {
        outputs = [...Array.from({ length: normal }, (_, i) => outputs![i] ?? []), []]
      }
      run.output = trim(outputs.map((arr) => arr.slice(0, 50)))
      st.nodeRuns.push(run)
      recordOutputs(node, outputs)
      propagate(id, outputs)
    } else {
      const message = (lastError as Error)?.message ?? String(lastError)
      run.status = 'error'
      run.error = maxTries > 1 ? `${message} (after ${maxTries} attempts)` : message
      const failed = items.map((i) => ({ ...i, json: { ...i.json, error: run.error } }))
      if (onError === 'continue') {
        const out = [failed.length ? failed : [{ json: { error: run.error } }]]
        run.output = trim(out)
        st.nodeRuns.push(run)
        recordOutputs(node, out)
        propagate(id, out)
      } else if (onError === 'errorOutput') {
        const out = [...Array.from({ length: normal }, () => [] as Item[]), failed.length ? failed : [{ json: { error: run.error } }]]
        run.output = trim(out)
        st.nodeRuns.push(run)
        recordOutputs(node, out)
        propagate(id, out)
      } else {
        st.nodeRuns.push(run)
        st.status = 'error'
        st.firstError ??= `${node.name}: ${run.error}`
        propagate(id, null)
      }
    }
    afterNode()
  }

  if (st.steps >= MAX_STEPS && st.ready.length > 0) {
    st.status = 'error'
    st.firstError ??= `Stopped after ${MAX_STEPS} steps — check for a loop that never finishes.`
  }
  return finish(st.status)
}

function toJson(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v }
}
