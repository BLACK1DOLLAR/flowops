import type {
  Credential, Execution, ExecutionSummary, Item, Workflow, WorkflowNode, WorkflowVersionSummary,
} from './types'

const TOKEN_KEY = 'flowops.apiToken'

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable — the token just won't be remembered */
  }
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = readToken()
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401 && !retried) {
    // The server was started with API_TOKEN: ask once, remember it in this browser.
    const entered = window.prompt('This FlowOps server requires an API token (the API_TOKEN it was started with):', '')
    if (entered) {
      writeToken(entered.trim())
      return request<T>(path, init, true)
    }
  }
  if (!res.ok) {
    if (res.status === 401) writeToken('')
    const body = await res.text().catch(() => '')
    let message = body.slice(0, 300)
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status}: ${message}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listWorkflows: () => request<Workflow[]>('/workflows'),
  getWorkflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (wf: Partial<Workflow>) => request<Workflow>('/workflows', { method: 'POST', body: JSON.stringify(wf) }),
  updateWorkflow: (id: string, patch: Partial<Workflow>) => request<Workflow>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteWorkflow: (id: string) => request<{ deleted: boolean }>(`/workflows/${id}`, { method: 'DELETE' }),
  activate: (id: string) =>
    request<{ workflow: Workflow; registered: { errors?: string[] } }>(`/workflows/${id}/activate`, { method: 'POST' }),
  deactivate: (id: string) => request<{ workflow: Workflow }>(`/workflows/${id}/deactivate`, { method: 'POST' }),
  triggers: (id: string) => request<TriggerInfoLike[]>(`/workflows/${id}/triggers`),

  versions: (id: string) => request<WorkflowVersionSummary[]>(`/workflows/${id}/versions`),
  restoreVersion: (id: string, versionId: string) =>
    request<Workflow>(`/workflows/${id}/versions/${versionId}/restore`, { method: 'POST' }),

  run: (id: string, mode: 'manual' | 'test', input?: unknown[]) =>
    request<{ execution: Execution; itemsByEdge: Record<string, number> }>(`/workflows/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ mode, input }),
    }),

  testNode: (node: WorkflowNode, input?: Item[], runData?: Record<string, Item[][]>) =>
    request<{ status: 'success' | 'error'; durationMs: number; outputs?: Item[][]; error?: string; logs?: string[] }>('/nodes/test', {
      method: 'POST',
      body: JSON.stringify({ node, input: input ?? [{ json: {} }], runData }),
    }),

  executions: (workflowId?: string) =>
    request<ExecutionSummary[]>(`/executions${workflowId ? `?workflowId=${workflowId}` : ''}`),
  execution: (id: string) => request<Execution>(`/executions/${id}`),
  replay: (id: string) =>
    request<{ execution: ExecutionSummary; itemsByEdge: Record<string, number> }>(`/executions/${id}/replay`, { method: 'POST' }),
  resume: (id: string) =>
    request<{ execution: Execution; itemsByEdge: Record<string, number> }>(`/executions/${id}/resume`, { method: 'POST', body: '{}' }),

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
