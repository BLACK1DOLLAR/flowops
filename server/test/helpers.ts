import type { Connection, Store, WorkflowNode, WorkflowRecord } from '../src/store/types.js'

/** Minimal store for engine tests: only credentials are read during a run. */
export function fakeStore(credentials: Record<string, { type: string; data: Record<string, string> }> = {}): Store {
  return {
    getCredential: async (id: string) => (credentials[id] ? { id, name: id, createdAt: '', ...credentials[id] } : null),
  } as unknown as Store
}

export function node(id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, name: extra.name ?? id, type, position: { x: 0, y: 0 }, parameters, ...extra }
}

export function edge(source: string, target: string, sourceOutput = 0, targetInput = 0): Connection {
  return { source, target, sourceOutput, targetInput }
}

export function workflow(nodes: WorkflowNode[], connections: Connection[]): WorkflowRecord {
  return { id: 'wf', name: 'test', active: false, nodes, connections, settings: {}, tags: [], createdAt: '', updatedAt: '' }
}

/** Manual trigger that emits the given items. */
export const trigger = (id = 't') => node(id, 'manualTrigger')

/** Code node returning a fixed list of JSON objects. */
export const source = (id: string, rows: unknown[]) =>
  node(id, 'code', { jsCode: `return ${JSON.stringify(rows)}` })
