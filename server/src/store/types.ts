// ---- Workflow graph -------------------------------------------------------

export interface WorkflowNode {
  id: string
  name: string
  type: string
  position: { x: number; y: number }
  parameters: Record<string, unknown>
  credentials?: Record<string, string> // credential slot -> credential id
  disabled?: boolean
  settings?: NodeSettings
  /** Pinned output: in manual/test runs the node returns this instead of executing. */
  pinData?: Item[]
}

export interface NodeSettings {
  retryOnFail?: boolean
  maxTries?: number // total attempts, including the first (default 3)
  waitBetweenTries?: number // ms (default 1000)
  /**
   * stop          – mark the node failed; downstream nodes are skipped (default)
   * continue      – pass the input items on with an `error` field added
   * errorOutput   – send failed items to an extra "error" output
   */
  onError?: 'stop' | 'continue' | 'errorOutput'
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

export type NodeStatus = 'success' | 'error' | 'skipped' | 'waiting'

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

export type ExecutionStatus = 'running' | 'success' | 'error' | 'waiting'

export interface ExecutionRecord {
  id: string
  workflowId: string
  workflowName?: string
  status: ExecutionStatus
  mode: ExecutionMode
  trigger?: { nodeId?: string; type?: string; payload?: unknown }
  nodeRuns: NodeRun[]
  error?: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  /** Set while status = 'waiting': when the run resumes on its own (absent = only via resume webhook). */
  waitTill?: string
  /** Serialized engine state for resuming a waiting execution. */
  resumeState?: unknown
}

export interface WorkflowVersion {
  id: string
  workflowId: string
  name: string
  nodes: WorkflowNode[]
  connections: Connection[]
  settings: WorkflowSettings
  createdAt: string
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
  /** Executions in 'waiting' status (any wait time). */
  listWaitingExecutions(): Promise<ExecutionRecord[]>

  addWorkflowVersion(v: Omit<WorkflowVersion, 'id' | 'createdAt'>): Promise<WorkflowVersion>
  listWorkflowVersions(workflowId: string, limit?: number): Promise<WorkflowVersion[]>
  getWorkflowVersion(id: string): Promise<WorkflowVersion | null>
}
