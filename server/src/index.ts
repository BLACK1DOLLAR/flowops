import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { createStore } from './store/postgres.js'
import { createQueue } from './queue.js'
import { TriggerManager } from './triggers.js'
import { createApi, createWebhookRouter } from './api.js'
import { executeWorkflow } from './engine/dag.js'

async function main(): Promise<void> {
  const store = await createStore()
  const queue = await createQueue()

  const triggers = new TriggerManager(store, (execution) => {
    console.log(`[exec] ${execution.id} ${execution.status} (${execution.mode})`)
  })

  // Production webhook executions run through the queue (async, with retries).
  await queue.start(async (job: any) => {
    if (job.name === 'webhook-run') {
      const { workflowId, route, payload } = job.data
      const wf = await store.getWorkflow(workflowId)
      if (!wf) return
      const startedAt = new Date()
      const record = await store.createExecution({
        workflowId,
        status: 'running',
        mode: 'production',
        trigger: { nodeId: route.nodeId, type: 'webhook', payload },
        nodeRuns: [],
        startedAt: startedAt.toISOString(),
      })
      const result = await executeWorkflow(store, {
        workflow: wf,
        mode: 'production',
        trigger: { nodeId: route.nodeId, type: 'webhook', payload },
      })
      const finishedAt = new Date()
      await store.updateExecution(record.id, {
        status: result.status,
        nodeRuns: result.nodeRuns,
        error: result.error,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      })
    }
  })

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
  app.use('/api', createApi(store, triggers, queue))
  app.use(createWebhookRouter(store, triggers, queue))

  app.get('/health', (_req, res) => res.json({ ok: true, store: config.databaseUrl ? 'postgres' : 'memory', queue: config.redisUrl ? 'bullmq' : 'inline' }))

  app.listen(config.port, () => {
    console.log(`[server] FlowOps API listening on http://localhost:${config.port}`)
  })

  await triggers.registerAllActive()

  const shutdown = async () => {
    console.log('\n[server] shutting down…')
    await queue.close()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
