import { create } from 'zustand'
import type {
  Credential, ExecutionSummary, Item, NodeSettings, Workflow, WorkflowConnection, WorkflowNode,
} from './types'
import { api } from './api'
import { newNode, newNodeId, outputCount, NODE_TYPES, type NodeTypeDef } from './registry'

export type NodeRunState = 'idle' | 'running' | 'success' | 'error' | 'skipped' | 'waiting'

export interface NodeRunInfo {
  status: NodeRunState
  durationMs?: number
  error?: string
  input?: Item[]
  output?: Item[][]
  logs?: string[]
}

/** What gets copied to the clipboard: nodes plus the connections between them. */
interface ClipboardPayload {
  flowops: 1
  nodes: WorkflowNode[]
  connections: WorkflowConnection[]
}

const HISTORY_LIMIT = 100

interface Store {
  workflow: Workflow
  dirty: boolean
  saving: boolean
  selectedNodeId: string | null
  inspectorOpen: boolean
  drawerOpen: boolean
  credentialsOpen: boolean
  /** Credential slot type the "new credential" modal was opened for. */
  credentialSlotType: string | null
  logsOpen: boolean
  historyOpen: boolean
  executions: ExecutionSummary[]
  nodeRuns: Record<string, NodeRunInfo>
  edgeItems: Record<string, number> // `${source}:${sourceOutput}:${target}:${targetInput}` -> count
  runError: string | null
  waitingExecutionId: string | null
  credentials: Credential[]
  past: Workflow[]
  future: Workflow[]

  setName: (name: string) => void
  setTags: (tags: string[]) => void
  toggleActive: () => Promise<string | null>
  loadWorkflow: (id: string) => Promise<void>
  newWorkflow: () => void
  save: () => Promise<string | null>
  deleteWorkflow: () => Promise<void>
  importWorkflow: (data: unknown) => Promise<void>
  exportWorkflow: () => string
  restoreVersion: (versionId: string) => Promise<void>

  undo: () => void
  redo: () => void
  copySelection: () => Promise<void>
  pasteFromClipboard: () => Promise<void>
  duplicateSelection: () => void

  select: (id: string | null) => void
  openInspector: (id: string) => void
  closeInspector: () => void
  setDrawerOpen: (open: boolean) => void
  setCredentialsOpen: (open: boolean, slotType?: string) => void
  setLogsOpen: (open: boolean) => void
  setHistoryOpen: (open: boolean) => void

  /**
   * Add a node. With no position (double-click in the drawer) it's placed to
   * the right of the selected node — or the last node — and wired to it.
   * With a position (drag and drop) it's wired only if a node is selected.
   */
  addNode: (type: string, position?: { x: number; y: number }) => void
  updateNode: (id: string, patch: Partial<WorkflowNode>) => void
  updateParameter: (id: string, name: string, value: unknown) => void
  updateNodeSettings: (id: string, patch: Partial<NodeSettings>) => void
  updateCredentialRef: (id: string, slot: string, credentialId: string) => void
  deleteNode: (id: string) => void
  onConnectionsChange: (connections: WorkflowConnection[]) => void
  pinOutput: (id: string) => void
  unpinOutput: (id: string) => void

  refreshCredentials: () => Promise<void>
  loadExecutions: () => Promise<void>

  testWorkflow: () => Promise<void>
  testNode: (nodeId: string) => Promise<void>
  resumeWaiting: () => Promise<void>
  clearRunState: () => void
  applyRunResult: (nodeRuns: Record<string, NodeRunInfo>, itemsByEdge: Record<string, number>) => void
}

function emptyWorkflow(): Workflow {
  return { name: 'My workflow', active: false, nodes: [], connections: [], settings: {}, tags: [] }
}

const edgeKey = (source: string, sourceOutput: number, target: string, targetInput: number) =>
  `${source}:${sourceOutput}:${target}:${targetInput}`

/** Drop connections that point at outputs a node no longer has (e.g. after turning off the error output). */
function pruneConnections(nodes: WorkflowNode[], connections: WorkflowConnection[]): WorkflowConnection[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return connections.filter((c) => {
    const src = byId.get(c.source)
    return src && byId.has(c.target) && c.sourceOutput < outputsFor(src)
  })
}

let memoryClipboard: ClipboardPayload | null = null

function keepServerFields(snapshot: Workflow, current: Workflow): Workflow {
  return { ...snapshot, id: current.id, active: current.active }
}

export const useStore = create<Store>((set, get) => {
  // Rapid edits to the same field (typing) merge into one undo step.
  let lastEditKey = ''
  let lastEditAt = 0

  /** Apply an edit to the workflow and record the previous state for undo. */
  const edit = (fn: (wf: Workflow) => Workflow, extra: Partial<Store> = {}, coalesceKey = '') => {
    const now = Date.now()
    const merge = coalesceKey !== '' && coalesceKey === lastEditKey && now - lastEditAt < 1500
    lastEditKey = coalesceKey
    lastEditAt = now
    set((s) => ({
      ...extra,
      past: merge ? s.past : [...s.past, s.workflow].slice(-HISTORY_LIMIT),
      future: [],
      workflow: fn(s.workflow),
      dirty: true,
    }))
  }

  const runsFromExecution = (nodeRuns: Array<{ nodeId: string; status: NodeRunState; durationMs: number; error?: string; input: Item[]; output: Item[][]; logs?: string[] }>) => {
    const runs: Record<string, NodeRunInfo> = {}
    for (const run of nodeRuns) {
      runs[run.nodeId] = { status: run.status, durationMs: run.durationMs, error: run.error, input: run.input, output: run.output, logs: run.logs }
    }
    return runs
  }

  const insertNodes = (payload: ClipboardPayload) => {
    if (!payload.nodes.length) return
    const { workflow } = get()
    const names = new Set(workflow.nodes.map((n) => n.name))
    const idMap = new Map<string, string>()
    const nodes = payload.nodes.map((n) => {
      const id = newNodeId()
      idMap.set(n.id, id)
      let name = n.name
      for (let i = 2; names.has(name); i++) name = `${n.name} ${i}`
      names.add(name)
      return { ...structuredClone(n), id, name, position: { x: n.position.x + 60, y: n.position.y + 60 } }
    })
    const connections = payload.connections
      .filter((c) => idMap.has(c.source) && idMap.has(c.target))
      .map((c) => ({ ...c, source: idMap.get(c.source)!, target: idMap.get(c.target)! }))
    edit(
      (wf) => ({ ...wf, nodes: [...wf.nodes, ...nodes], connections: [...wf.connections, ...connections] }),
      { selectedNodeId: nodes[nodes.length - 1].id },
    )
  }

  const selectionPayload = (): ClipboardPayload | null => {
    const { workflow, selectedNodeId } = get()
    const node = workflow.nodes.find((n) => n.id === selectedNodeId)
    if (!node) return null
    return { flowops: 1, nodes: [structuredClone(node)], connections: [] }
  }

  return {
    workflow: emptyWorkflow(),
    dirty: false,
    saving: false,
    selectedNodeId: null,
    inspectorOpen: false,
    drawerOpen: false,
    credentialsOpen: false,
    credentialSlotType: null,
    logsOpen: false,
    historyOpen: false,
    executions: [],
    nodeRuns: {},
    edgeItems: {},
    runError: null,
    waitingExecutionId: null,
    credentials: [],
    past: [],
    future: [],

    setName: (name) => edit((wf) => ({ ...wf, name }), {}, 'workflow-name'),
    setTags: (tags) => edit((wf) => ({ ...wf, tags })),

    toggleActive: async () => {
      let wf = get().workflow
      if (!wf.id || get().dirty) {
        await get().save()
        wf = get().workflow
      }
      if (!wf.id) throw new Error('Save the workflow before activating it.')
      if (wf.active) {
        const result = await api.deactivate(wf.id)
        set({ workflow: { ...result.workflow }, dirty: false })
        return null
      }
      const result = await api.activate(wf.id)
      set({ workflow: { ...result.workflow }, dirty: false })
      return result.registered?.errors?.length ? result.registered.errors.join('; ') : null
    },

    loadWorkflow: async (id) => {
      const wf = await api.getWorkflow(id)
      set({ workflow: wf, dirty: false, nodeRuns: {}, edgeItems: {}, selectedNodeId: null, inspectorOpen: false, past: [], future: [], waitingExecutionId: null })
    },

    newWorkflow: () =>
      set({ workflow: emptyWorkflow(), dirty: false, nodeRuns: {}, edgeItems: {}, selectedNodeId: null, inspectorOpen: false, past: [], future: [], waitingExecutionId: null }),

    save: async () => {
      const wf = get().workflow
      set({ saving: true })
      try {
        const saved = wf.id ? await api.updateWorkflow(wf.id, wf) : await api.createWorkflow(wf)
        set({ workflow: saved, dirty: false })
        return saved.id ?? null
      } finally {
        set({ saving: false })
      }
    },

    deleteWorkflow: async () => {
      const wf = get().workflow
      if (wf.id) await api.deleteWorkflow(wf.id)
      get().newWorkflow()
    },

    importWorkflow: async (data) => {
      const raw = data as Partial<Workflow>
      if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) {
        throw new Error('That file is not a FlowOps workflow (expected "nodes" and "connections").')
      }
      const saved = await api.createWorkflow({
        name: `${raw.name ?? 'Imported workflow'}`,
        nodes: raw.nodes,
        connections: raw.connections,
        settings: raw.settings ?? {},
        tags: raw.tags ?? [],
        active: false,
      })
      set({ workflow: saved, dirty: false, nodeRuns: {}, edgeItems: {}, selectedNodeId: null, inspectorOpen: false, past: [], future: [] })
    },

    exportWorkflow: () => {
      const { name, nodes, connections, settings, tags } = get().workflow
      // Credentials are references only (ids), never secrets, so the file is safe to share.
      return JSON.stringify({ name, nodes, connections, settings, tags }, null, 2)
    },

    restoreVersion: async (versionId) => {
      const wf = get().workflow
      if (!wf.id) return
      const restored = await api.restoreVersion(wf.id, versionId)
      set((s) => ({ past: [...s.past, s.workflow].slice(-HISTORY_LIMIT), future: [], workflow: restored, dirty: false, nodeRuns: {}, edgeItems: {} }))
    },

    // Undo/redo only touch what the user edits; the id and active state belong to the server.
    undo: () =>
      set((s) => {
        const prev = s.past[s.past.length - 1]
        if (!prev) return s
        return { past: s.past.slice(0, -1), future: [s.workflow, ...s.future], workflow: keepServerFields(prev, s.workflow), dirty: true }
      }),
    redo: () =>
      set((s) => {
        const next = s.future[0]
        if (!next) return s
        return { future: s.future.slice(1), past: [...s.past, s.workflow], workflow: keepServerFields(next, s.workflow), dirty: true }
      }),

    copySelection: async () => {
      const payload = selectionPayload()
      if (!payload) return
      memoryClipboard = payload
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload))
      } catch {
        /* clipboard blocked — the in-memory copy still works inside this tab */
      }
    },

    pasteFromClipboard: async () => {
      let payload = memoryClipboard
      try {
        const text = await navigator.clipboard.readText()
        const parsed = JSON.parse(text) as ClipboardPayload
        if (parsed?.flowops === 1 && Array.isArray(parsed.nodes)) payload = parsed
      } catch {
        /* not our data, or clipboard blocked */
      }
      if (payload) insertNodes(payload)
    },

    duplicateSelection: () => {
      const payload = selectionPayload()
      if (payload) insertNodes(payload)
    },

    select: (id) => set((s) => (s.selectedNodeId === id ? s : { selectedNodeId: id })),
    openInspector: (id) =>
      set((s) => (s.selectedNodeId === id && s.inspectorOpen ? s : { selectedNodeId: id, inspectorOpen: true })),
    closeInspector: () => set({ inspectorOpen: false }),
    setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
    setCredentialsOpen: (credentialsOpen, slotType) => set({ credentialsOpen, credentialSlotType: slotType ?? null }),
    setLogsOpen: (logsOpen) => set({ logsOpen }),
    setHistoryOpen: (historyOpen) => set({ historyOpen }),

    addNode: (type, position) => {
      const node = newNode(type)
      const { workflow, selectedNodeId } = get()
      const names = new Set(workflow.nodes.map((n) => n.name))
      for (let i = 2; names.has(node.name); i++) node.name = `${NODE_TYPES[type]?.name ?? type} ${i}`
      const selected = workflow.nodes.find((n) => n.id === selectedNodeId)
      const anchor = position ? selected : selected ?? workflow.nodes[workflow.nodes.length - 1]

      if (position) {
        node.position = position
      } else if (anchor) {
        // Next column to the right; step down if that spot is already taken.
        let pos = { x: anchor.position.x + 280, y: anchor.position.y }
        while (workflow.nodes.some((n) => Math.abs(n.position.x - pos.x) < 200 && Math.abs(n.position.y - pos.y) < 110)) {
          pos = { x: pos.x, y: pos.y + 140 }
        }
        node.position = pos
      } else {
        node.position = { x: 120, y: 120 }
      }

      // Auto-connect anchor → new node through the anchor's first free output.
      let connections = workflow.connections
      const accepts = (NODE_TYPES[type]?.inputs ?? 0) > 0
      if (anchor && accepts) {
        const outs = outputsFor(anchor)
        for (let i = 0; i < outs; i++) {
          if (!connections.some((c) => c.source === anchor.id && c.sourceOutput === i)) {
            connections = [...connections, { source: anchor.id, sourceOutput: i, target: node.id, targetInput: 0 }]
            break
          }
        }
      }

      edit((wf) => ({ ...wf, nodes: [...wf.nodes, node], connections }), { selectedNodeId: node.id, inspectorOpen: true })
    },

    updateNode: (id, patch) => {
      // Renames would break `$('Old name')` expressions; history keeps them undoable.
      const key = 'name' in patch ? `name:${id}` : ''
      edit((wf) => ({ ...wf, nodes: wf.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), {}, key)
    },

    updateParameter: (id, name, value) =>
      edit((wf) => {
        const nodes = wf.nodes.map((n) => (n.id === id ? { ...n, parameters: { ...n.parameters, [name]: value } } : n))
        return { ...wf, nodes, connections: pruneConnections(nodes, wf.connections) }
      }, {}, `param:${id}:${name}`),

    updateNodeSettings: (id, patch) =>
      edit((wf) => {
        const nodes = wf.nodes.map((n) => (n.id === id ? { ...n, settings: { ...n.settings, ...patch } } : n))
        return { ...wf, nodes, connections: pruneConnections(nodes, wf.connections) }
      }),

    updateCredentialRef: (id, slot, credentialId) =>
      edit((wf) => ({
        ...wf,
        nodes: wf.nodes.map((n) => (n.id === id ? { ...n, credentials: { ...n.credentials, [slot]: credentialId } } : n)),
      })),

    deleteNode: (id) =>
      edit(
        (wf) => ({
          ...wf,
          nodes: wf.nodes.filter((n) => n.id !== id),
          connections: wf.connections.filter((c) => c.source !== id && c.target !== id),
        }),
        {
          selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
          inspectorOpen: get().selectedNodeId === id ? false : get().inspectorOpen,
        },
      ),

    onConnectionsChange: (connections) => edit((wf) => ({ ...wf, connections })),

    pinOutput: (id) => {
      const output = get().nodeRuns[id]?.output?.[0]
      if (!output?.length) return
      edit((wf) => ({ ...wf, nodes: wf.nodes.map((n) => (n.id === id ? { ...n, pinData: structuredClone(output) } : n)) }))
    },
    unpinOutput: (id) =>
      edit((wf) => ({
        ...wf,
        nodes: wf.nodes.map((n) => {
          if (n.id !== id) return n
          const { pinData: _pin, ...rest } = n
          return rest
        }),
      })),

    refreshCredentials: async () => set({ credentials: await api.credentials() }),
    loadExecutions: async () => set({ executions: await api.executions(get().workflow.id) }),

    clearRunState: () => set({ nodeRuns: {}, edgeItems: {}, runError: null }),

    applyRunResult: (nodeRuns, itemsByEdge) => set({ nodeRuns, edgeItems: itemsByEdge }),

    testWorkflow: async () => {
      const { workflow } = get()
      if (workflow.nodes.length === 0) return
      set({ runError: null })
      // optimistic running state for all non-disabled nodes
      const optimistic: Record<string, NodeRunInfo> = {}
      for (const n of workflow.nodes) {
        if (!n.disabled) optimistic[n.id] = { status: 'running' }
      }
      set({ nodeRuns: optimistic, edgeItems: {} })

      try {
        // Always save first so the run uses what is on the canvas.
        const id = get().dirty || !workflow.id ? await get().save() : workflow.id
        if (!id) return
        const { execution, itemsByEdge } = await api.run(id, 'manual')
        set({
          nodeRuns: runsFromExecution(execution.nodeRuns),
          edgeItems: itemsByEdge,
          logsOpen: true,
          waitingExecutionId: execution.status === 'waiting' ? execution.id : null,
          runError: execution.status === 'waiting' ? 'Waiting — the run will resume on its own, or press Resume now.' : null,
        })
        await get().loadExecutions()
      } catch (err) {
        set({ runError: (err as Error).message, nodeRuns: {} })
      }
    },

    resumeWaiting: async () => {
      const id = get().waitingExecutionId
      if (!id) return
      try {
        const { execution, itemsByEdge } = await api.resume(id)
        set({
          nodeRuns: runsFromExecution(execution.nodeRuns),
          edgeItems: itemsByEdge,
          waitingExecutionId: execution.status === 'waiting' ? execution.id : null,
          runError: execution.status === 'waiting' ? 'Still waiting at a later Wait node.' : null,
        })
        await get().loadExecutions()
      } catch (err) {
        set({ runError: (err as Error).message, waitingExecutionId: null })
      }
    },

    testNode: async (nodeId) => {
      const { workflow, nodeRuns } = get()
      const node = workflow.nodes.find((n) => n.id === nodeId)
      if (!node) return
      set((s) => ({ nodeRuns: { ...s.nodeRuns, [nodeId]: { status: 'running' } } }))
      // Feed the node the last known upstream output as input, if available.
      const upstream = workflow.connections
        .filter((c) => c.target === nodeId)
        .map((c) => nodeRuns[c.source]?.output?.[c.sourceOutput] ?? [])
        .flat()
      // Earlier outputs by node name, so `$('Node')` works in a single-step test.
      const runData: Record<string, Item[][]> = {}
      for (const n of workflow.nodes) {
        const out = nodeRuns[n.id]?.output ?? (n.pinData ? [n.pinData] : undefined)
        if (out) runData[n.name] = out
      }
      try {
        const result = await api.testNode(node, upstream.length > 0 ? upstream : undefined, runData)
        set((s) => ({
          nodeRuns: {
            ...s.nodeRuns,
            [nodeId]: { status: result.status, durationMs: result.durationMs, error: result.error, output: result.outputs, input: upstream, logs: result.logs },
          },
        }))
      } catch (err) {
        set((s) => ({ nodeRuns: { ...s.nodeRuns, [nodeId]: { status: 'error', error: (err as Error).message } } }))
      }
    },
  }
})

// Helpers shared by components ------------------------------------------------

export function nodeDef(type: string): NodeTypeDef | undefined {
  return NODE_TYPES[type]
}

export function outputsFor(node: WorkflowNode): number {
  const def = NODE_TYPES[node.type]
  if (!def) return 1
  return outputCount(def, node)
}

export { edgeKey }

// Devtools: expose the store for browser-console debugging in dev builds.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __flowops?: unknown }).__flowops = useStore
}
