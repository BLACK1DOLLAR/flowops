import type { Credential, Execution, ExecutionSummary, Item, Workflow, WorkflowNode } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listWorkflows: () => request<Workflow[]>('/workflows'),
  getWorkflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (wf: Partial<Workflow>) => request<Workflow>('/workflows', { method: 'POST', body: JSON.stringify(wf) }),
  updateWorkflow: (id: string, patch: Partial<Workflow>) => request<Workflow>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteWorkflow: (id: string) => request<{ deleted: boolean }>(`/workflows/${id}`, { method: 'DELETE' }),
  activate: (id: string) => request<{ workflow: Workflow; registered: unknown }>(`/workflows/${id}/activate`, { method: 'POST' }),
  deactivate: (id: string) => request<{ workflow: Workflow }>(`/workflows/${id}/deactivate`, { method: 'POST' }),
  triggers: (id: string) => request<TriggerInfoLike[]>(`/workflows/${id}/triggers`),

  run: (id: string, mode: 'manual' | 'test', input?: unknown[]) =>
    request<{ execution: Execution; itemsByEdge: Record<string, number> }>(`/workflows/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ mode, input }),
    }),

  testNode: (node: WorkflowNode, input?: Item[]) =>
    request<{ status: 'success' | 'error'; durationMs: number; outputs?: Item[][]; error?: string }>('/nodes/test', {
      method: 'POST',
      body: JSON.stringify({ node, input: input ?? [{ json: {} }] }),
    }),

  executions: (workflowId?: string) =>
    request<ExecutionSummary[]>(`/executions${workflowId ? `?workflowId=${workflowId}` : ''}`),
  execution: (id: string) => request<Execution>(`/executions/${id}`),
  replay: (id: string) =>
    request<{ execution: ExecutionSummary; itemsByEdge: Record<string, number> }>(`/executions/${id}/replay`, { method: 'POST' }),

  credentials: () => request<Credential[]>('/credentials'),
  createCredential: (name: string, type: string, data: Record<string, string>) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify({ name, type, data }) }),
  deleteCredential: (id: string) => request<{ deleted: boolean }>(`/credentials/${id}`, { method: 'DELETE' }),
}

interface TriggerInfoLike {
  type: string
  path?: string
  method?: string
  cron?: string
  nodeId: string
}
