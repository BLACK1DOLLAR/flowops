import type { ExecutionRecord, Item, Store, WorkflowRecord } from './store/types.js'
import { executeWorkflow, type EngineState, type RunResult } from './engine/dag.js'
import type { WebhookResponse } from './engine/nodes.js'

const jsonItem = (v: unknown): Item => ({
  json: v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v },
})

export interface RunOptions {
  trigger?: ExecutionRecord['trigger']
  inputItems?: Item[]
  onResponse?: (response: WebhookResponse) => void
}

/**
 * Create an execution record, run the workflow, and store the outcome.
 * Waiting runs keep their engine state so the resume scheduler (or the resume
 * webhook) can continue them later.
 */
export async function runAndRecord(
  store: Store,
  wf: WorkflowRecord,
  mode: ExecutionRecord['mode'],
  opts: RunOptions = {},
): Promise<{ execution: ExecutionRecord; itemsByEdge: Record<string, number> }> {
  const startedAt = new Date()
  const record = await store.createExecution({
    workflowId: wf.id,
    status: 'running',
    mode,
    trigger: opts.trigger,
    nodeRuns: [],
    startedAt: startedAt.toISOString(),
  })
  let result: RunResult
  try {
    result = await executeWorkflow(store, {
      workflow: wf,
      mode,
      trigger: opts.trigger,
      inputItems: opts.inputItems,
      executionId: record.id,
      onResponse: opts.onResponse,
    })
  } catch (err) {
    result = { status: 'error', nodeRuns: [], itemsByEdge: {}, error: (err as Error).message }
  }
  const execution = await saveResult(store, wf, record, startedAt, result)
  return { execution, itemsByEdge: result.itemsByEdge }
}

/** Continue a waiting execution. `data` is the resume-webhook payload, if any. */
export async function resumeExecution(
  store: Store,
  exec: ExecutionRecord,
  data?: unknown,
): Promise<{ execution: ExecutionRecord; itemsByEdge: Record<string, number> } | null> {
  if (exec.status !== 'waiting' || !exec.resumeState) return null
  const wf = await store.getWorkflow(exec.workflowId)
  if (!wf) {
    await store.updateExecution(exec.id, { status: 'error', error: 'Workflow was deleted while waiting', waitTill: undefined, resumeState: null })
    return null
  }
  // Claim the run first so a second resume (timer + webhook) can't run it twice.
  const claimed = await store.updateExecution(exec.id, { status: 'running', waitTill: undefined })
  if (!claimed) return null
  let result: RunResult
  try {
    result = await executeWorkflow(store, {
      workflow: wf,
      mode: exec.mode,
      trigger: exec.trigger,
      executionId: exec.id,
      resume: { state: exec.resumeState as EngineState, data },
    })
  } catch (err) {
    result = { status: 'error', nodeRuns: exec.nodeRuns, itemsByEdge: {}, error: (err as Error).message }
  }
  const execution = await saveResult(store, wf, exec, new Date(exec.startedAt), result)
  return { execution, itemsByEdge: result.itemsByEdge }
}

async function saveResult(
  store: Store,
  wf: WorkflowRecord,
  record: ExecutionRecord,
  startedAt: Date,
  result: RunResult,
): Promise<ExecutionRecord> {
  const finishedAt = new Date()
  const waiting = result.status === 'waiting'
  const saved = await store.updateExecution(record.id, {
    status: result.status,
    nodeRuns: result.nodeRuns,
    error: result.error,
    ...(waiting
      ? { waitTill: result.waitTill, resumeState: result.resumeState }
      : { finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(), waitTill: undefined, resumeState: null }),
  })

  // Error workflow routing: forward failures to a designated workflow.
  if (result.status === 'error') {
    const errorWorkflowId = (wf.settings as Record<string, any>)?.errorWorkflow
    if (errorWorkflowId && errorWorkflowId !== wf.id) {
      const errorWf = await store.getWorkflow(errorWorkflowId)
      if (errorWf) {
        await runAndRecord(store, errorWf, 'production', {
          inputItems: [jsonItem({ error: result.error, workflowId: wf.id, workflowName: wf.name, executionId: record.id, failedAt: finishedAt.toISOString() })],
        }).catch((err) => console.error('[engine] error workflow failed:', err))
      }
    }
  }
  return saved ?? record
}

/** Poll for waiting executions whose time has come and resume them. */
export function startResumeScheduler(store: Store, intervalMs = 5000): () => void {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = Date.now()
      for (const exec of await store.listWaitingExecutions()) {
        if (exec.waitTill && new Date(exec.waitTill).getTime() <= now) {
          const res = await resumeExecution(store, exec)
          if (res) console.log(`[exec] resumed ${exec.id} → ${res.execution.status}`)
        }
      }
    } catch (err) {
      console.error('[resume] scheduler error:', err)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  void tick()
  return () => clearInterval(timer)
}
