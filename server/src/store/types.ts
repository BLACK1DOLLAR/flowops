// ---- Workflow graph -------------------------------------------------------

export interface WorkflowNode {
  id: string
  name: string
  type: string
  position: { x: number; y: number }
  parameters: Record<string, unknown>
  credentials?: Record<string, string> // credential slot -> credential id
  disabled?: boolean
}

export interface Connection {
  source: string
  sourceOutput: number // output handle index (0-based)
  target: string
  targetInput: number // input handle index (0-based)
}

export interface WorkflowSettings {
  errorWorkflow?: string
  timezone?: string
  [key: string]: unknown
}

export interface WorkflowRecord {
  id: string
  name: string
  active: boolean
  nodes: WorkflowNode[]
  connections: Connection[]
  settings: WorkflowSettings
  tags: string[]
  createdAt: string
  updatedAt: string
}

// ---- Credentials ----------------------------------------------------------

export interface CredentialRecord {
  id: string
  name: string
  type: string
  data: Record<string, string> // decrypted; never sent to the client
  createdAt: string
}

export interface CredentialSummary {
  id: string
  name: string
  type: string
  createdAt: string
}

// ---- Execution data -------------------------------------------------------

export interface Item {
  json: Record<string, unknown>
  binary?: Record<string, unknown>
}

export type NodeStatus = 'success' | 'error' | 'skipped'

export interface NodeRun {
  nodeId: string
  nodeName: string
  nodeType: string
  status: NodeStatus
  startedAt: string
  durationMs: number
  input: Item[] // snapshot of the first input
  output: Item[][] // per output index
  error?: string
  logs?: string[]
}

export type ExecutionMode = 'manual' | 'test' | 'production' | 'retry'

export interface ExecutionRecord {
  id: string
  workflowId: string
  workflowName?: string
  status: 'running' | 'success' | 'error'
  mode: ExecutionMode
  trigger?: { nodeId?: string; type?: string; payload?: unknown }
  nodeRuns: NodeRun[]
  error?: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
}

export interface TriggerInfo {
  type: 'webhook' | 'schedule' | 'manual'
  path?: string
  method?: string
  cron?: string
  nodeId: string
}

// ---- Persistence ----------------------------------------------------------

export interface Store {
  init(): Promise<void>
  close(): Promise<void>

  listWorkflows(): Promise<WorkflowRecord[]>
  getWorkflow(id: string): Promise<WorkflowRecord | null>
  createWorkflow(w: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkflowRecord>
  updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<WorkflowRecord | null>
  deleteWorkflow(id: string): Promise<boolean>

  listCredentials(): Promise<CredentialSummary[]>
  getCredential(id: string): Promise<CredentialRecord | null>
  createCredential(name: string, type: string, data: Record<string, string>): Promise<CredentialSummary>
  updateCredential(id: string, name: string, data: Record<string, string>): Promise<CredentialSummary | null>
  deleteCredential(id: string): Promise<boolean>

  createExecution(e: Omit<ExecutionRecord, 'id'>): Promise<ExecutionRecord>
  updateExecution(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null>
  listExecutions(workflowId?: string, limit?: number): Promise<ExecutionRecord[]>
  getExecution(id: string): Promise<ExecutionRecord | null>
  deleteExecution(id: string): Promise<boolean>
}
