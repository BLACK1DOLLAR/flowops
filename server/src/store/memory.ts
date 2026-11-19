import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../config.js'
import { encryptJson, decryptJson } from '../crypto.js'
import type {
  CredentialRecord,
  CredentialSummary,
  ExecutionRecord,
  Store,
  WorkflowRecord,
} from './types.js'

// ---------------------------------------------------------------------------
// In-memory store with JSON-file persistence (zero-config mode)
// ---------------------------------------------------------------------------

interface MemoryShape {
  workflows: Record<string, WorkflowRecord>
  credentials: Record<string, { id: string; name: string; type: string; enc: string; createdAt: string }>
  executions: ExecutionRecord[]
}

function uid(): string {
  return globalThis.crypto.randomUUID()
}

export class MemoryStore implements Store {
  private data: MemoryShape = { workflows: {}, credentials: {}, executions: [] }
  private saveTimer: NodeJS.Timeout | undefined

  async init(): Promise<void> {
    try {
      const raw = readFileSync(resolve(config.dataFile), 'utf8')
      this.data = JSON.parse(raw) as MemoryShape
    } catch {
      mkdirSync(dirname(resolve(config.dataFile)), { recursive: true })
    }
  }

  async close(): Promise<void> {}

  private persist(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(resolve(config.dataFile)), { recursive: true })
        writeFileSync(resolve(config.dataFile), JSON.stringify(this.data, null, 2))
      } catch (err) {
        console.error('[store] failed to persist', err)
      }
    }, 300)
  }

  async listWorkflows(): Promise<WorkflowRecord[]> {
    return Object.values(this.data.workflows).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async getWorkflow(id: string): Promise<WorkflowRecord | null> {
    return this.data.workflows[id] ?? null
  }
  async createWorkflow(w: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkflowRecord> {
    const rec: WorkflowRecord = { ...w, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.data.workflows[rec.id] = rec
    this.persist()
    return rec
  }
  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<WorkflowRecord | null> {
    const rec = this.data.workflows[id]
    if (!rec) return null
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return rec
  }
  async deleteWorkflow(id: string): Promise<boolean> {
    if (!this.data.workflows[id]) return false
    delete this.data.workflows[id]
    this.data.executions = this.data.executions.filter((e) => e.workflowId !== id)
    this.persist()
    return true
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    return Object.values(this.data.credentials).map(({ enc: _enc, ...c }) => c)
  }
  async getCredential(id: string): Promise<CredentialRecord | null> {
    const c = this.data.credentials[id]
    if (!c) return null
    return { id: c.id, name: c.name, type: c.type, data: decryptJson(c.enc), createdAt: c.createdAt }
  }
  async createCredential(name: string, type: string, data: Record<string, string>): Promise<CredentialSummary> {
    const rec = { id: uid(), name, type, enc: encryptJson(data), createdAt: new Date().toISOString() }
    this.data.credentials[rec.id] = rec
    this.persist()
    const { enc: _enc, ...summary } = rec
    return summary
  }
  async updateCredential(id: string, name: string, data: Record<string, string>): Promise<CredentialSummary | null> {
    const rec = this.data.credentials[id]
    if (!rec) return null
    rec.name = name
    rec.enc = encryptJson(data)
    this.persist()
    const { enc: _enc, ...summary } = rec
    return summary
  }
  async deleteCredential(id: string): Promise<boolean> {
    if (!this.data.credentials[id]) return false
    delete this.data.credentials[id]
    this.persist()
    return true
  }

  async createExecution(e: Omit<ExecutionRecord, 'id'>): Promise<ExecutionRecord> {
    const rec: ExecutionRecord = { ...e, id: uid() }
    this.data.executions.unshift(rec)
    this.data.executions = this.data.executions.slice(0, 500)
    this.persist()
    return rec
  }
  async updateExecution(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const rec = this.data.executions.find((e) => e.id === id)
    if (!rec) return null
    Object.assign(rec, patch)
    this.persist()
    return rec
  }
  async listExecutions(workflowId?: string, limit = 50): Promise<ExecutionRecord[]> {
    return this.data.executions
      .filter((e) => !workflowId || e.workflowId === workflowId)
      .slice(0, limit)
  }
  async getExecution(id: string): Promise<ExecutionRecord | null> {
    return this.data.executions.find((e) => e.id === id) ?? null
  }
  async deleteExecution(id: string): Promise<boolean> {
    const before = this.data.executions.length
    this.data.executions = this.data.executions.filter((e) => e.id !== id)
    if (this.data.executions.length === before) return false
    this.persist()
    return true
  }
}

// Trim helper shared by engines: cap stored snapshots to keep rows small.
export function trimItems<T>(items: T, maxChars = 12000): T {
  try {
    const s = JSON.stringify(items)
    if (s.length <= maxChars) return items
    return JSON.parse(s.slice(0, maxChars)) as T
  } catch {
    return items
  }
}
