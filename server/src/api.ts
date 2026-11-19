import { Router, raw, json } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, WorkflowRecord, Item, ExecutionRecord } from './store/types.js'
import { getNodeHandler, type WebhookResponse } from './engine/nodes.js'
import { TriggerManager, type WebhookRoute } from './triggers.js'
import type { JobQueue } from './queue.js'
import { runAndRecord, resumeExecution } from './runner.js'

/** Accept either plain JSON values or `{ json }` items. */
const toItem = (v: unknown): Item => {
  if (v && typeof v === 'object' && 'json' in (v as object) && typeof (v as Item).json === 'object') return v as Item
  return { json: v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v } }
}

function summarizeExecution(exec: ExecutionRecord) {
  const { nodeRuns, resumeState: _state, ...rest } = exec
  return { ...rest, nodeCount: nodeRuns.length }
}

/** Never send engine resume state to clients. */
const publicExecution = (exec: ExecutionRecord) => {
  const { resumeState: _state, ...rest } = exec
  return rest
}

interface WebhookDeps {
  store: Store
  triggers: TriggerManager
  queue: JobQueue
}

function verifySignature(secret: string, rawBody: Buffer | undefined, provided: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody ?? Buffer.alloc(0)).digest('hex')
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendResponse(res: any, r: WebhookResponse) {
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, String(v))
  res.status(r.statusCode || 200)
  if (typeof r.body === 'string') res.send(r.body)
  else res.json(r.body ?? {})
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
  if (!testMode && (route.hmacCredentialId || route.hmacSecret)) {
    let secret = route.hmacSecret
    if (route.hmacCredentialId) {
      const cred = await store.getCredential(route.hmacCredentialId)
      secret = cred?.data.secret
      if (!secret) return res.status(500).json({ error: 'The webhook signing credential is missing.' })
    }
    if (!verifySignature(secret!, req.rawBody, req.header('x-signature') ?? '')) {
      return res.status(401).json({ error: 'Invalid webhook signature' })
    }
  }

  // Production routes use express.raw (for the signature); parse JSON bodies here.
  let body: unknown = req.body ?? null
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8')
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
  }
  const payload = {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('x-') && k !== 'authorization' && k !== 'cookie')),
    query: req.query ?? {},
    body,
  }

  const wf = await store.getWorkflow(workflowId)
  if (!wf) return res.status(404).json({ error: 'Workflow not found' })
  const trigger = { nodeId: route.nodeId, type: 'webhook', payload }

  if (route.responseMode === 'immediately' && !testMode) {
    await queue.enqueue('webhook-run', { workflowId, route, payload })
    return res.json({ message: 'Execution queued' })
  }

  // Synchronous run: answer from a "Respond to Webhook" node, or with the last node's output.
  let sent = false
  const onResponse = (r: WebhookResponse) => {
    if (sent || res.headersSent) return
    sent = true
    sendResponse(res, r)
  }
  const { execution, itemsByEdge } = await runAndRecord(store, wf, testMode ? 'test' : 'production', {
    trigger,
    onResponse: route.responseMode === 'responseNode' ? onResponse : undefined,
  })
  if (sent) return
  const last = [...execution.nodeRuns].reverse().find((n) => n.status === 'success')
  const data = last?.output?.find((o) => o.length > 0)?.[0]?.json ?? null
  if (testMode) {
    return res.json({ execution: summarizeExecution(execution), itemsByEdge, data })
  }
  if (execution.status === 'error') return res.status(500).json({ error: execution.error ?? 'Workflow failed' })
  if (route.responseMode === 'responseNode') {
    return res.json({ message: execution.status === 'waiting' ? 'Workflow is waiting' : 'Workflow finished without a Respond to Webhook node running' })
  }
  res.json(data ?? {})
}

export function createApi(
  store: Store,
  triggers: TriggerManager,
  queue: JobQueue,
): Router {
  const api = Router()
  void queue

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
    if (nodes !== undefined && !Array.isArray(nodes)) return res.status(400).json({ error: 'nodes must be an array' })
    if (connections !== undefined && !Array.isArray(connections)) return res.status(400).json({ error: 'connections must be an array' })
    const wf = await store.createWorkflow({
      name: name ?? 'Untitled workflow',
      nodes: nodes ?? [],
      connections: connections ?? [],
      settings: settings ?? {},
      tags: tags ?? [],
      active: Boolean(active),
    })
    await store.addWorkflowVersion({ workflowId: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings })
    if (wf.active) triggers.register(wf)
    res.status(201).json(wf)
  })

  api.put('/workflows/:id', async (req, res) => {
    const existing = await store.getWorkflow(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Workflow not found' })
    const { name, nodes, connections, settings, tags, active } = req.body ?? {}
    const patch: Partial<WorkflowRecord> = {}
    if (name !== undefined) patch.name = name
    if (nodes !== undefined) patch.nodes = nodes
    if (connections !== undefined) patch.connections = connections
    if (settings !== undefined) patch.settings = settings
    if (tags !== undefined) patch.tags = tags
    if (active !== undefined) patch.active = Boolean(active)
    const before = JSON.stringify([existing.name, existing.nodes, existing.connections, existing.settings])
    const wf = await store.updateWorkflow(req.params.id, patch)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    if (JSON.stringify([wf.name, wf.nodes, wf.connections, wf.settings]) !== before) {
      await store.addWorkflowVersion({ workflowId: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings })
    }
    // Keep live triggers in sync with the saved graph.
    if (wf.active) triggers.register(wf)
    else triggers.unregister(wf.id)
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
  // Version history
  // ---------------------------------------------------------------------------

  api.get('/workflows/:id/versions', async (req, res) => {
    const versions = await store.listWorkflowVersions(req.params.id)
    res.json(versions.map((v) => ({ id: v.id, name: v.name, createdAt: v.createdAt, nodeCount: v.nodes.length })))
  })

  api.get('/workflows/:id/versions/:versionId', async (req, res) => {
    const v = await store.getWorkflowVersion(req.params.versionId)
    if (!v || v.workflowId !== req.params.id) return res.status(404).json({ error: 'Version not found' })
    res.json(v)
  })

  api.post('/workflows/:id/versions/:versionId/restore', async (req, res) => {
    const v = await store.getWorkflowVersion(req.params.versionId)
    if (!v || v.workflowId !== req.params.id) return res.status(404).json({ error: 'Version not found' })
    const wf = await store.updateWorkflow(req.params.id, { name: v.name, nodes: v.nodes, connections: v.connections, settings: v.settings })
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    await store.addWorkflowVersion({ workflowId: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings })
    if (wf.active) triggers.register(wf)
    res.json(wf)
  })

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  // Manual/test run — synchronous so the editor gets full results immediately.
  api.post('/workflows/:id/run', async (req, res) => {
    const wf = await store.getWorkflow(req.params.id)
    if (!wf) return res.status(404).json({ error: 'Workflow not found' })
    const { mode, input } = (req.body ?? {}) as { mode?: string; input?: unknown }
    const runMode: ExecutionRecord['mode'] = mode === 'test' ? 'test' : 'manual'
    try {
      const items: Item[] | undefined = Array.isArray(input) ? input.map(toItem) : undefined
      const { execution, itemsByEdge } = await runAndRecord(store, wf, runMode, { inputItems: items })
      res.json({ execution: publicExecution(execution), itemsByEdge })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Single-node "Test Step".
  api.post('/nodes/test', async (req, res) => {
    const { node, input, runData } = (req.body ?? {}) as {
      node?: WorkflowRecord['nodes'][number]
      input?: unknown[]
      runData?: Record<string, Item[][]>
    }
    if (!node) return res.status(400).json({ error: 'node is required' })
    const items: Item[] = (Array.isArray(input) && input.length ? input : [{ json: {} }]).map(toItem)
    const startedAt = Date.now()
    const logs: string[] = []
    try {
      const handler = getNodeHandler(node.type)
      const outputs = await handler({
        node: structuredClone(node),
        items,
        inputs: [items],
        trigger: items[0]?.json ?? {},
        mode: 'test',
        logs,
        getCredential: async (credId) => {
          const cred = await store.getCredential(credId)
          return cred ? { type: cred.type, data: cred.data } : null
        },
        store,
        runData: runData && typeof runData === 'object' ? runData : {},
      })
      res.json({ status: 'success', durationMs: Date.now() - startedAt, outputs: outputs.map((arr) => arr.slice(0, 50)), logs })
    } catch (err) {
      res.json({ status: 'error', durationMs: Date.now() - startedAt, error: (err as Error).message, logs })
    }
  })

  // ---------------------------------------------------------------------------
  // Executions
  // ---------------------------------------------------------------------------

  api.get('/executions', async (req, res) => {
    const { workflowId, limit } = req.query as { workflowId?: string; limit?: string }
    const execs = await store.listExecutions(workflowId, Math.min(500, Number(limit ?? 50) || 50))
    res.json(execs.map(summarizeExecution))
  })

  api.get('/executions/:id', async (req, res) => {
    const exec = await store.getExecution(req.params.id)
    if (!exec) return res.status(404).json({ error: 'Execution not found' })
    res.json(publicExecution(exec))
  })

  api.post('/executions/:id/replay', async (req, res) => {
    const exec = await store.getExecution(req.params.id)
    if (!exec) return res.status(404).json({ error: 'Execution not found' })
    const wf = await store.getWorkflow(exec.workflowId)
    if (!wf) return res.status(404).json({ error: 'Workflow no longer exists' })
    try {
      const { execution, itemsByEdge } = await runAndRecord(store, wf, 'retry', { trigger: exec.trigger ?? undefined })
      res.json({ execution: summarizeExecution(execution), itemsByEdge })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Resume a waiting execution now (from the editor).
  api.post('/executions/:id/resume', async (req, res) => {
    const exec = await store.getExecution(req.params.id)
    if (!exec) return res.status(404).json({ error: 'Execution not found' })
    const result = await resumeExecution(store, exec, req.body && Object.keys(req.body).length ? req.body : undefined)
    if (!result) return res.status(409).json({ error: 'This execution is not waiting' })
    res.json({ execution: publicExecution(result.execution), itemsByEdge: result.itemsByEdge })
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
 * Webhook endpoints live at the site root (/webhook/..., /webhook-test/...,
 * /webhook-waiting/...) rather than under /api, so they are mounted on a
 * separate router and are not behind the API token.
 */
export function createWebhookRouter(
  store: Store,
  triggers: TriggerManager,
  queue: JobQueue,
): Router {
  const router = Router()
  const deps = { store, triggers, queue }
  // Raw body so HMAC signatures are computed over the exact bytes received.
  router.all('/webhook/:workflowId/:path', raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    ;(req as any).rawBody = req.body
    return handleWebhook(deps, req, res, false)
  })
  router.all('/webhook-test/:workflowId/:path', json({ limit: '10mb' }), (req, res) => handleWebhook(deps, req, res, true))
  // Resume a run paused on a Wait node set to "until the resume webhook is called".
  router.all('/webhook-waiting/:executionId', json({ limit: '10mb' }), async (req, res) => {
    const exec = await store.getExecution(req.params.executionId)
    if (!exec || exec.status !== 'waiting') return res.status(404).json({ error: 'No waiting execution with this id' })
    const data = { method: req.method, query: req.query ?? {}, body: req.body ?? null }
    const result = await resumeExecution(store, exec, data)
    if (!result) return res.status(409).json({ error: 'This execution is no longer waiting' })
    res.json({ resumed: true, status: result.execution.status })
  })
  return router
}

export type { ExecutionRecord }
