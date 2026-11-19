import express from 'express'
import cors from 'cors'
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeConfig, config } from './config.js'
import { createStore } from './store/postgres.js'
import { createQueue } from './queue.js'
import { TriggerManager } from './triggers.js'
import { createApi, createWebhookRouter } from './api.js'
import { runAndRecord, startResumeScheduler } from './runner.js'

/** Require `Authorization: Bearer <API_TOKEN>` when a token is configured. */
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.apiToken) return next()
  const header = req.header('authorization') ?? ''
  const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(config.apiToken)
  if (provided.length === expected.length && timingSafeEqual(provided, expected)) return next()
  res.status(401).json({ error: 'Missing or invalid API token' })
}

async function main(): Promise<void> {
  assertSafeConfig()
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
      const { execution } = await runAndRecord(store, wf, 'production', {
        trigger: { nodeId: route.nodeId, type: 'webhook', payload },
      })
      console.log(`[exec] ${execution.id} ${execution.status} (webhook)`)
    }
  })

  const app = express()
  app.disable('x-powered-by')
  // No cross-origin access unless CORS_ORIGIN lists the allowed origins.
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }))

  // Webhooks first: they parse their own bodies (raw bytes for HMAC checks)
  // and are public by design — protect them with HMAC signing credentials.
  app.use(createWebhookRouter(store, triggers, queue))
  app.use('/api', requireToken, express.json({ limit: '10mb' }), createApi(store, triggers, queue))

  app.get('/health', (_req, res) => res.json({ ok: true, store: config.databaseUrl ? 'postgres' : 'memory', queue: config.redisUrl ? 'bullmq' : 'inline' }))

  // Serve the built editor (web/dist) when it exists, so one process runs everything.
  const webDist = process.env.WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }))
    app.get(/^\/(?!api\/|webhook).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')))
    console.log(`[server] serving the editor from ${webDist}`)
  }

  app.listen(config.port, config.host, () => {
    console.log(`[server] FlowOps API listening on http://${config.host}:${config.port}${config.apiToken ? ' (API token required)' : ''}`)
  })

  await triggers.registerAllActive()
  const stopResume = startResumeScheduler(store)

  const shutdown = async () => {
    console.log('\n[server] shutting down…')
    stopResume()
    await queue.close()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[server] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
