import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { config } from '../config.js'
import { encryptJson, decryptJson } from '../crypto.js'
import { MemoryStore, trimItems } from './memory.js'
import type { Store } from './types.js'
import type { CredentialSummary, ExecutionRecord, WorkflowRecord } from './types.js'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../db/schema.sql')

function uid(): string {
  return globalThis.crypto.randomUUID()
}

type WorkflowRow = {
  id: string
  name: string
  active: boolean
  nodes: WorkflowRecord['nodes']
  connections: WorkflowRecord['connections']
  settings: WorkflowRecord['settings']
  tags: string[]
  created_at: Date
  updated_at: Date
}

function rowToWorkflow(r: WorkflowRow): WorkflowRecord {
  return {
    id: r.id,
    name: r.name,
    active: r.active,
    nodes: r.nodes,
    connections: r.connections,
    settings: r.settings,
    tags: r.tags,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}

type ExecRow = {
  id: string
  workflow_id: string
  status: ExecutionRecord['status']
  mode: ExecutionRecord['mode']
  trigger: ExecutionRecord['trigger']
  node_runs: ExecutionRecord['nodeRuns']
  error: string | null
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
}

function rowToExecution(r: ExecRow, workflowName?: string): ExecutionRecord {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName,
    status: r.status,
    mode: r.mode,
    trigger: r.trigger,
    nodeRuns: r.node_runs,
    error: r.error ?? undefined,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString(),
    durationMs: r.duration_ms ?? undefined,
  }
}

export class PostgresStore implements Store {
  private pool: pg.Pool
  private fallback: MemoryStore | null = null

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  }

  async init(): Promise<void> {
    await this.pool.query(readFileSync(SCHEMA_PATH, 'utf8'))
    console.log('[store] PostgreSQL schema verified')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  // -- workflows ------------------------------------------------------------

  async listWorkflows(): Promise<WorkflowRecord[]> {
    const { rows } = await this.pool.query<WorkflowRow>('SELECT * FROM workflows ORDER BY updated_at DESC')
    return rows.map(rowToWorkflow)
  }
  async getWorkflow(id: string): Promise<WorkflowRecord | null> {
    const { rows } = await this.pool.query<WorkflowRow>('SELECT * FROM workflows WHERE id = $1', [id])
    return rows[0] ? rowToWorkflow(rows[0]) : null
  }
  async createWorkflow(w: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkflowRecord> {
    const { rows } = await this.pool.query<WorkflowRow>(
      `INSERT INTO workflows (name, active, nodes, connections, settings, tags)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [w.name, w.active, JSON.stringify(w.nodes), JSON.stringify(w.connections), JSON.stringify(w.settings), w.tags],
    )
    return rowToWorkflow(rows[0])
  }
  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<WorkflowRecord | null> {
    const { rows } = await this.pool.query<WorkflowRow>(
      `UPDATE workflows SET
         name = COALESCE($2, name),
         active = COALESCE($3, active),
         nodes = COALESCE($4, nodes),
         connections = COALESCE($5, connections),
         settings = COALESCE($6, settings),
         tags = COALESCE($7, tags),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.active ?? null,
        patch.nodes ? JSON.stringify(patch.nodes) : null,
        patch.connections ? JSON.stringify(patch.connections) : null,
        patch.settings ? JSON.stringify(patch.settings) : null,
        patch.tags ?? null,
      ],
    )
    return rows[0] ? rowToWorkflow(rows[0]) : null
  }
  async deleteWorkflow(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM workflows WHERE id = $1', [id])
    return (rowCount ?? 0) > 0
  }

  // -- credentials (AES-256-GCM encrypted payloads) --------------------------

  async listCredentials(): Promise<CredentialSummary[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; type: string; data_encrypted: string; created_at: Date }>(
      'SELECT id, name, type, data_encrypted, created_at FROM credentials ORDER BY created_at DESC',
    )
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, createdAt: r.created_at.toISOString() }))
  }
  async getCredential(id: string): Promise<{ id: string; name: string; type: string; data: Record<string, string>; createdAt: string } | null> {
    const { rows } = await this.pool.query<{ id: string; name: string; type: string; data_encrypted: string; created_at: Date }>(
      'SELECT id, name, type, data_encrypted, created_at FROM credentials WHERE id = $1',
      [id],
    )
    if (!rows[0]) return null
    const r = rows[0]
    return { id: r.id, name: r.name, type: r.type, data: decryptJson(r.data_encrypted), createdAt: r.created_at.toISOString() }
  }
  async createCredential(name: string, type: string, data: Record<string, string>): Promise<CredentialSummary> {
    const { rows } = await this.pool.query<{ id: string; name: string; type: string; created_at: Date }>(
      'INSERT INTO credentials (name, type, data_encrypted) VALUES ($1,$2,$3) RETURNING id, name, type, created_at',
      [name, type, encryptJson(data)],
    )
    return { id: rows[0].id, name: rows[0].name, type: rows[0].type, createdAt: rows[0].created_at.toISOString() }
  }
  async updateCredential(id: string, name: string, data: Record<string, string>): Promise<CredentialSummary | null> {
    const { rows } = await this.pool.query<{ id: string; name: string; type: string; created_at: Date }>(
      'UPDATE credentials SET name = $2, data_encrypted = $3 WHERE id = $1 RETURNING id, name, type, created_at',
      [id, name, encryptJson(data)],
    )
    if (!rows[0]) return null
    return { id: rows[0].id, name: rows[0].name, type: rows[0].type, createdAt: rows[0].created_at.toISOString() }
  }
  async deleteCredential(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM credentials WHERE id = $1', [id])
    return (rowCount ?? 0) > 0
  }

  // -- executions -------------------------------------------------------------

  async createExecution(e: Omit<ExecutionRecord, 'id'>): Promise<ExecutionRecord> {
    const { rows } = await this.pool.query<ExecRow>(
      `INSERT INTO executions (workflow_id, status, mode, trigger, node_runs, error, started_at, finished_at, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        e.workflowId,
        e.status,
        e.mode,
        e.trigger ? JSON.stringify(e.trigger) : null,
        JSON.stringify(e.nodeRuns.map((n) => ({ ...n, input: trimItems(n.input), output: trimItems(n.output) }))),
        e.error ?? null,
        e.startedAt,
        e.finishedAt ?? null,
        e.durationMs ?? null,
      ],
    )
    return rowToExecution(rows[0])
  }
  async updateExecution(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const { rows } = await this.pool.query<ExecRow>(
      `UPDATE executions SET
         status = COALESCE($2, status),
         node_runs = COALESCE($3, node_runs),
         error = COALESCE($4, error),
         finished_at = COALESCE($5, finished_at),
         duration_ms = COALESCE($6, duration_ms)
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.nodeRuns ? JSON.stringify(patch.nodeRuns) : null,
        patch.error ?? null,
        patch.finishedAt ?? null,
        patch.durationMs ?? null,
      ],
    )
    return rows[0] ? rowToExecution(rows[0]) : null
  }
  async listExecutions(workflowId?: string, limit = 50): Promise<ExecutionRecord[]> {
    const { rows } = workflowId
      ? await this.pool.query<ExecRow>(
          'SELECT * FROM executions WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT $2',
          [workflowId, limit],
        )
      : await this.pool.query<ExecRow>('SELECT * FROM executions ORDER BY started_at DESC LIMIT $1', [limit])
    return rows.map((r) => rowToExecution(r))
  }
  async getExecution(id: string): Promise<ExecutionRecord | null> {
    const { rows } = await this.pool.query<ExecRow>('SELECT * FROM executions WHERE id = $1', [id])
    if (!rows[0]) return null
    const wf = await this.getWorkflow(rows[0].workflow_id)
    return rowToExecution(rows[0], wf?.name)
  }
  async deleteExecution(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM executions WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }
}

/** Pick Postgres when DATABASE_URL is configured, else the zero-config store. */
export async function createStore(): Promise<Store> {
  if (config.databaseUrl) {
    try {
      const store = new PostgresStore(config.databaseUrl)
      await store.init()
      console.log('[store] Using PostgreSQL')
      return store
    } catch (err) {
      console.error('[store] PostgreSQL unavailable, falling back to memory store:', (err as Error).message)
    }
  }
  const store = new MemoryStore()
  await store.init()
  console.log('[store] Using in-memory store with JSON persistence at', config.dataFile)
  return store
}
