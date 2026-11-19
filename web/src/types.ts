// Shared client-side types (mirrors server/src/store/types.ts)

export interface WorkflowNode {
  id: string
  name: string
  type: string
  position: { x: number; y: number }
  parameters: Record<string, unknown>
  credentials?: Record<string, string>
  disabled?: boolean
  settings?: NodeSettings
  pinData?: Item[]
}

export interface NodeSettings {
  retryOnFail?: boolean
  maxTries?: number
  waitBetweenTries?: number
  onError?: 'stop' | 'continue' | 'errorOutput'
}

export interface WorkflowConnection {
  source: string
  sourceOutput: number
  target: string
  targetInput: number
}

export interface Workflow {
  id?: string
  name: string
  active: boolean
  nodes: WorkflowNode[]
  connections: WorkflowConnection[]
  settings: Record<string, unknown>
  tags: string[]
}

export interface Item {
  json: Record<string, unknown>
  binary?: Record<string, unknown>
}

export interface NodeRun {
  nodeId: string
  nodeName: string
  nodeType: string
  status: 'success' | 'error' | 'skipped' | 'waiting'
  startedAt: string
  durationMs: number
  input: Item[]
  output: Item[][]
  error?: string
  logs?: string[]
}

export interface Execution {
  id: string
  workflowId: string
  workflowName?: string
  status: 'running' | 'success' | 'error' | 'waiting'
  mode: 'manual' | 'test' | 'production' | 'retry'
  trigger?: { nodeId?: string; type?: string; payload?: unknown }
  nodeRuns: NodeRun[]
  error?: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  waitTill?: string
}

export type ExecutionSummary = Omit<Execution, 'nodeRuns'> & { nodeCount: number }

export interface Credential {
  id: string
  name: string
  type: string
  createdAt: string
}

export interface TriggerInfo {
  type: 'webhook' | 'schedule' | 'manual'
  path?: string
  method?: string
  cron?: string
  nodeId: string
}

export interface WorkflowVersionSummary {
  id: string
  name: string
  createdAt: string
  nodeCount: number
}
