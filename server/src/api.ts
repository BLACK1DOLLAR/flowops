import { Router, raw } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, WorkflowRecord, Item, ExecutionRecord } from './store/types.js'
import { executeWorkflow } from './engine/dag.js'
import { getNodeHandler } from './engine/nodes.js'
import { TriggerManager, type WebhookRoute } from './triggers.js'
import type { JobQueue } from './queue.js'

const jsonItem = (v: unknown): Item => ({
  json: v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v },
})

function summarizeExecution(exec: ExecutionRecord) {
  const { nodeRuns, ...rest } = exec
  return { ...rest, nodeCount: nodeRuns.length }
}

interface WebhookDeps {
  store: Store
  triggers: TriggerManager
  queue: JobQueue
}

async function runAndRecord(
  store: Store,
  wf: WorkflowRecord,
  mode: ExecutionRecord['mode'],
  trigger?: ExecutionRecord['trigger'],
  inputItems?: Item[],
): Promise<{ execution: ExecutionRecord; itemsByEdge: Record<string, number> }> {
  const startedAt = new Date()
  const record = await store.createExecution({
    workflowId: wf.id,
    status: 'running',
    mode,
    trigger,
    nodeRuns: [],
    startedAt: startedAt.toISOString(),
  })

  const result = await executeWorkflow(store, {
    workflow: wf,
    mode,
    trigger,
    inputItems,
  })

  const finishedAt = new Date()
  const finished = await store.updateExecution(record.id, {
    status: result.status,
    nodeRuns: result.nodeRuns,
    error: result.error,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  })

  // Error workflow routing: forward failures to a designated workflow.
  if (result.status === 'error') {
    const errorWorkflowId = (wf.settings as Record<string, any>)?.errorWorkflow
    if (errorWorkflowId) {
      const errorWf = await store.getWorkflow(errorWorkflowId)
      if (errorWf) {
        await executeWorkflow(store, {
          workflow: errorWf,
          mode: 'production',
          inputItems: [jsonItem({ error: result.error, workflowId: wf.id, executionId: record.id, failedAt: finishedAt.toISOString() })],
        }).catch((err) => console.error('[engine] error workflow failed:', err))
      }
    }
  }

  return { execution: finished ?? record, itemsByEdge: result.itemsByEdge }
}

async function handleWebhook(deps: WebhookDeps, req: any, res: any, testMode: boolean) {
  const { store, triggers, queue } = deps
  const { workflowId, path } = req.params
  const route: WebhookRoute | undefined = triggers.findWebhook(workflowId, path)
  if (!route) return res.status(404).json({ error: 'Webhook not registered — activate the workflow first.' })
  if (!testMode) {
    const method = route.method.toUpperCase()
    if (method !== 'ALL' && req.method !== method) {
      return res.status(405).json({ error: `Webhook expects ${method}` })
    }
  }

  // HMAC signature validation (production routes with a configured secret).
  if (route.hmacSecret && !testMode) {
    const rawBody = (req as any).rawBody as Buffer
    const provided = req.header('x-signature') ?? ''
    const expected = createHmac('sha256', route.hmacSecret).update(rawBody).digest('hex')
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (provided.length !== expected.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid webhook signature' })
    }
  }

  const payload = {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('x-'))),
    query: req.query ?? {},
    body: req.body ?? null,
  }

  const wf = await store.getWorkflow(workflowId)
  if (!wf) return res.status(404).json({ error: 'Workflow not found' })

  if (testMode) {
    const { execution, itemsByEdge } = await runAndRecord(store, wf, 'test', {
      nodeId: route.nodeId,
      type: 'webhook',
      payload,
    })
    // Respond with the last successful node output for easy debugging.
    const last = [...execution.nodeRuns].reverse().find((n) => n.status === 'success')
    return res.json({
      execution: summarizeExecution(execution),
      itemsByEdge,
      data: last?.output?.[0]?.[0]?.json ?? null,
    })
  }

  await queue.enqueue('webhook-run', { workflowId, route, payload })
  res.json({ message: 'Execution queued' })
}

export function createApi(
  store: Store,
  triggers: TriggerManager,
  queue: JobQueue,
): Router {
  const api = Router()

  // ---------------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------------

  api.get('/workflows', async (_req, res) => {
    res.json(await store.listWorkflows())
  })

  api.get('/workflows/:id', async (req, res) => {
    const wf = await store.getWorkflow(req.params.id)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    res.json(wf)
  })

  api.post('/workflows', async (req, res) => {
    const { name, nodes, connections, settings, tags, active } = req.body ?? {}
    const wf = await store.createWorkflow({
      name: name ?? 'Untitled workflow',
      nodes: nodes ?? [],
      connections: connections ?? [],
      settings: settings ?? {},
      tags: tags ?? [],
      active: Boolean(active),
    })
    if (wf.active) triggers.register(wf)
    res.status(201).json(wf)
  })

  api.put('/workflows/:id', async (req, res) => {
    const existing = await store.getWorkflow(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Workflow not found' })
    const wf = await store.updateWorkflow(req.params.id, req.body)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    // Keep live triggers in sync with the saved graph.
    if (wf.active) {
      triggers.register(wf)
    } else {
      triggers.unregister(wf.id)
    }
    res.json(wf)
  })

  api.delete('/workflows/:id', async (req, res) => {
    triggers.unregister(req.params.id)
    const ok = await store.deleteWorkflow(req.params.id)
    res.json({ deleted: ok })
  })

  api.post('/workflows/:id/activate', async (req, res) => {
    const wf = await store.updateWorkflow(req.params.id, { active: true })
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    const registered = triggers.register(wf)
    res.json({ workflow: wf, registered })
  })

  api.post('/workflows/:id/deactivate', async (req, res) => {
    const wf = await store.updateWorkflow(req.params.id, { active: false })
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    triggers.unregister(wf.id)
    res.json({ workflow: wf })
  })

  api.get('/workflows/:id/triggers', async (req, res) => {
    const wf = await store.getWorkflow(req.params.id)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    res.json(triggers.extractTriggers(wf))
  })

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  // Manual/test run — synchronous so the editor gets full results immediately.
  api.post('/workflows/:id/run', async (req, res) => {
    const wf = await store.getWorkflow(req.params.id)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    const { mode, input } = (req.body ?? {}) as { mode?: string; input?: unknown }
    try {
      const items: Item[] | undefined = Array.isArray(input) ? input.map(jsonItem) : undefined
      const { execution, itemsByEdge } = await runAndRecord(store, wf, (mode as ExecutionRecord['mode']) ?? 'manual', undefined, items)
      res.json({ execution, itemsByEdge })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Single-node "Test Step".
  api.post('/nodes/test', async (req, res) => {
    const { node, input, credentials } = (req.body ?? {}) as {
      node?: WorkflowRecord['nodes'][number]
      input?: unknown[]
      credentials?: Record<string, string>
    }
    if (!node) return res.status(400).json({ error: 'node is required' })
    const items: Item[] = (input ?? [{ json: {} }]).map(jsonItem)
    const startedAt = Date.now()
    try {
      const handler = getNodeHandler(node.type)
      const outputs = await handler({
        node: structuredClone(node),
        items,
        inputs: [items],
        trigger: items[0]?.json ?? {},
        mode: 'test',
        logs: [],
        getCredential: async (credId) => {
          const cred = await store.getCredential(credId)
          return cred ? { type: cred.type, data: cred.data } : null
        },
        store,
      })
      res.json({
        status: 'success',
        durationMs: Date.now() - startedAt,
        outputs: outputs.map((arr) => arr.slice(0, 50)),
      })
    } catch (err) {
      res.json({
        status: 'error',
        durationMs: Date.now() - startedAt,
        error: (err as Error).message,
      })
    }
  })

  // Production webhook execution — queued with retries.
  // (handleWebhook lives at module level, shared with createWebhookRouter.)

  // ---------------------------------------------------------------------------
  // Executions
  // ---------------------------------------------------------------------------

  api.get('/executions', async (req, res) => {
    const { workflowId, limit } = req.query as { workflowId?: string; limit?: string }
    const execs = await store.listExecutions(workflowId, Number(limit ?? 50))
    res.json(execs.map(summarizeExecution))
  })

  api.get('/executions/:id', async (req, res) => {
    const exec = await store.getExecution(req.params.id)
    if (!exec) return res.status(404).json({ error: 'Execution not found' })
    res.json(exec)
  })

  api.post('/executions/:id/replay', async (req, res) => {
    const exec = await store.getExecution(req.params.id)
    if (!exec) return res.status(404).json({ error: 'Execution not found' })
    const wf = await store.getWorkflow(exec.workflowId)
    if (!wf) return res.status(404).json({ error: 'Workflow no longer exists' })
    try {
      const { execution, itemsByEdge } = await runAndRecord(
        store,
        wf,
        'retry',
        exec.trigger ?? undefined,
        exec.nodeRuns.find((n) => n.status !== 'skipped')?.input,
      )
      res.json({ execution: summarizeExecution(execution), itemsByEdge })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  api.delete('/executions/:id', async (req, res) => {
    res.json({ deleted: await store.deleteExecution(req.params.id) })
  })

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------

  api.get('/credentials', async (_req, res) => {
    res.json(await store.listCredentials())
  })

  api.post('/credentials', async (req, res) => {
    const { name, type, data } = req.body ?? {}
    if (!name || !type || !data) return res.status(400).json({ error: 'name, type and data are required' })
    const cred = await store.createCredential(name, type, data)
    res.status(201).json(cred)
  })

  api.put('/credentials/:id', async (req, res) => {
    const { name, data } = req.body ?? {}
    const cred = await store.updateCredential(req.params.id, name, data)
    if (!cred) return res.status(404).json({ error: 'Credential not found' })
    res.json(cred)
  })

  api.delete('/credentials/:id', async (req, res) => {
    res.json({ deleted: await store.deleteCredential(req.params.id) })
  })

  return api
}

/**
 * Webhook endpoints live at the site root (/webhook/..., /webhook-test/...)
 * rather than under /api, so they are mounted on a separate router.
 */
export function createWebhookRouter(
  store: Store,
  triggers: TriggerManager,
  queue: JobQueue,
): Router {
  const router = Router()
  const deps = { store, triggers, queue }
  router.all('/webhook/:workflowId/:path', raw({ type: '*/*' }), (req, res) => handleWebhook(deps, req, res, false))
  router.all('/webhook-test/:workflowId/:path', (req, res) => handleWebhook(deps, req, res, true))
  return router
}

export type { ExecutionRecord }
