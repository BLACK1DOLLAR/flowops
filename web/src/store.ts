import { create } from 'zustand'
import type {
  Credential, ExecutionSummary, Item, Workflow, WorkflowConnection, WorkflowNode,
} from './types'
import { api } from './api'
import { newNode, outputCount, NODE_TYPES, type NodeTypeDef } from './registry'

export type NodeRunState = 'idle' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeRunInfo {
  status: NodeRunState
  durationMs?: number
  error?: string
  input?: Item[]
  output?: Item[][]
  logs?: string[]
}

interface Store {
  workflow: Workflow
  dirty: boolean
  saving: boolean
  selectedNodeId: string | null
  inspectorOpen: boolean
  drawerOpen: boolean
  credentialsOpen: boolean
  logsOpen: boolean
  executions: ExecutionSummary[]
  nodeRuns: Record<string, NodeRunInfo>
  edgeItems: Record<string, number> // `${source}:${sourceOutput}:${target}:${targetInput}` -> count
  runError: string | null
  credentials: Credential[]

  setName: (name: string) => void
  setTags: (tags: string[]) => void
  toggleActive: () => Promise<void>
  loadWorkflow: (id: string) => Promise<void>
  newWorkflow: () => void
  save: () => Promise<string | null>
  deleteWorkflow: () => Promise<void>

  select: (id: string | null) => void
  openInspector: (id: string) => void
  closeInspector: () => void
  setDrawerOpen: (open: boolean) => void
  setCredentialsOpen: (open: boolean) => void
  setLogsOpen: (open: boolean) => void

  /**
   * Add a node. With no position (double-click in the drawer) it's placed to
   * the right of the selected node — or the last node — and wired to it.
   * With a position (drag and drop) it's wired only if a node is selected.
   */
  addNode: (type: string, position?: { x: number; y: number }) => void
  updateNode: (id: string, patch: Partial<WorkflowNode>) => void
  updateParameter: (id: string, name: string, value: unknown) => void
  updateCredentialRef: (id: string, slot: string, credentialId: string) => void
  deleteNode: (id: string) => void
  onConnectionsChange: (connections: WorkflowConnection[]) => void

  refreshCredentials: () => Promise<void>
  loadExecutions: () => Promise<void>

  testWorkflow: () => Promise<void>
  testNode: (nodeId: string) => Promise<void>
  clearRunState: () => void
  applyRunResult: (nodeRuns: Record<string, NodeRunInfo>, itemsByEdge: Record<string, number>) => void
}

function emptyWorkflow(): Workflow {
  return { name: 'My workflow', active: false, nodes: [], connections: [], settings: {}, tags: [] }
}

const edgeKey = (source: string, sourceOutput: number, target: string, targetInput: number) =>
  `${source}:${sourceOutput}:${target}:${targetInput}`

export const useStore = create<Store>((set, get) => ({
  workflow: emptyWorkflow(),
  dirty: false,
  saving: false,
  selectedNodeId: null,
  inspectorOpen: false,
  drawerOpen: false,
  credentialsOpen: false,
  logsOpen: false,
  executions: [],
  nodeRuns: {},
  edgeItems: {},
  runError: null,
  credentials: [],

  setName: (name) => set((s) => ({ workflow: { ...s.workflow, name }, dirty: true })),
  setTags: (tags) => set((s) => ({ workflow: { ...s.workflow, tags }, dirty: true })),

  toggleActive: async () => {
    const wf = get().workflow
    if (!wf.id) throw new Error('Save the workflow before activating it.')
    const result = wf.active
      ? await api.deactivate(wf.id)
      : await api.activate(wf.id)
    set({ workflow: { ...result.workflow }, dirty: false })
  },

  loadWorkflow: async (id) => {
    const wf = await api.getWorkflow(id)
    set({ workflow: wf, dirty: false, nodeRuns: {}, edgeItems: {}, selectedNodeId: null, inspectorOpen: false })
  },

  newWorkflow: () => set({ workflow: emptyWorkflow(), dirty: false, nodeRuns: {}, edgeItems: {}, selectedNodeId: null, inspectorOpen: false }),

  save: async () => {
    const wf = get().workflow
    set({ saving: true })
    try {
      if (wf.id) {
        const saved = await api.updateWorkflow(wf.id, wf)
        set({ workflow: saved, dirty: false })
        return saved.id ?? null
      }
      const saved = await api.createWorkflow(wf)
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

  select: (id) => set((s) => (s.selectedNodeId === id ? s : { selectedNodeId: id })),
  openInspector: (id) =>
    set((s) =>
      s.selectedNodeId === id && s.inspectorOpen ? s : { selectedNodeId: id, inspectorOpen: true },
    ),
  closeInspector: () => set({ inspectorOpen: false }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setCredentialsOpen: (credentialsOpen) => set({ credentialsOpen }),
  setLogsOpen: (logsOpen) => set({ logsOpen }),

  addNode: (type, position) => {
    const node = newNode(type)
    const { workflow, selectedNodeId } = get()
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

    set((s) => ({
      workflow: { ...s.workflow, nodes: [...s.workflow.nodes, node], connections },
      dirty: true,
      selectedNodeId: node.id,
      inspectorOpen: true,
    }))
  },

  updateNode: (id, patch) =>
    set((s) => ({
      workflow: { ...s.workflow, nodes: s.workflow.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) },
      dirty: true,
    })),

  updateParameter: (id, name, value) =>
    set((s) => ({
      workflow: {
        ...s.workflow,
        nodes: s.workflow.nodes.map((n) =>
          n.id === id ? { ...n, parameters: { ...n.parameters, [name]: value } } : n,
        ),
      },
      dirty: true,
    })),

  updateCredentialRef: (id, slot, credentialId) =>
    set((s) => ({
      workflow: {
        ...s.workflow,
        nodes: s.workflow.nodes.map((n) =>
          n.id === id ? { ...n, credentials: { ...n.credentials, [slot]: credentialId } } : n,
        ),
      },
      dirty: true,
    })),

  deleteNode: (id) =>
    set((s) => ({
      workflow: {
        ...s.workflow,
        nodes: s.workflow.nodes.filter((n) => n.id !== id),
        connections: s.workflow.connections.filter((c) => c.source !== id && c.target !== id),
      },
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
      inspectorOpen: s.selectedNodeId === id ? false : s.inspectorOpen,
      dirty: true,
    })),

  onConnectionsChange: (connections) =>
    set((s) => ({ workflow: { ...s.workflow, connections }, dirty: true })),

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
      const id = workflow.id ?? (await get().save())
      if (!id) return
      const { execution, itemsByEdge } = await api.run(id, 'manual')
      const runs: Record<string, NodeRunInfo> = {}
      for (const run of execution.nodeRuns) {
        runs[run.nodeId] = {
          status: run.status,
          durationMs: run.durationMs,
          error: run.error,
          input: run.input,
          output: run.output,
          logs: run.logs,
        }
      }
      set({ nodeRuns: runs, edgeItems: itemsByEdge, logsOpen: true })
      await get().loadExecutions()
    } catch (err) {
      set({ runError: (err as Error).message })
      set({ nodeRuns: {} })
    }
  },

  testNode: async (nodeId) => {
    const node = get().workflow.nodes.find((n) => n.id === nodeId)
    if (!node) return
    set((s) => ({ nodeRuns: { ...s.nodeRuns, [nodeId]: { status: 'running' } } }))
    // Feed the node the last known upstream output as input, if available.
    const upstream = get().workflow.connections
      .filter((c) => c.target === nodeId)
      .map((c) => get().nodeRuns[c.source]?.output?.[c.sourceOutput] ?? [])
      .flat()
    try {
      const result = await api.testNode(node, upstream.length > 0 ? upstream : undefined)
      set((s) => ({
        nodeRuns: {
          ...s.nodeRuns,
          [nodeId]: {
            status: result.status,
            durationMs: result.durationMs,
            error: result.error,
            output: result.outputs,
            input: upstream,
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        nodeRuns: { ...s.nodeRuns, [nodeId]: { status: 'error', error: (err as Error).message } },
      }))
    }
  },
}))

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
