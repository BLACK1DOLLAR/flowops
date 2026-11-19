import cron, { type ScheduledTask } from 'node-cron'
import type { Store, TriggerInfo, WorkflowRecord } from './store/types.js'
import { executeWorkflow } from './engine/dag.js'

export interface WebhookRoute {
  workflowId: string
  nodeId: string
  path: string
  method: string
  hmacSecret?: string
}

/**
 * Registers/unregisters live triggers: HTTP webhook routes and cron schedules.
 * Called whenever a workflow is activated, deactivated or saved while active.
 */
export class TriggerManager {
  private webhooks = new Map<string, WebhookRoute>() // `${workflowId}:${path}` -> route
  private cronTasks = new Map<string, ScheduledTask[]>()

  constructor(
    private store: Store,
    private onExecutionStarted: (execution: ExecutionLike) => void,
  ) {}

  listWebhookRoutes(): WebhookRoute[] {
    return [...this.webhooks.values()]
  }

  findWebhook(workflowId: string, path: string): WebhookRoute | undefined {
    return this.webhooks.get(`${workflowId}:${path}`)
  }

  extractTriggers(workflow: WorkflowRecord): TriggerInfo[] {
    const triggers: TriggerInfo[] = []
    for (const node of workflow.nodes) {
      if (node.type === 'webhook') {
        triggers.push({
          type: 'webhook',
          nodeId: node.id,
          path: String(node.parameters.path ?? ''),
          method: String(node.parameters.method ?? 'POST'),
        })
      } else if (node.type === 'schedule') {
        triggers.push({ type: 'schedule', nodeId: node.id, cron: String(node.parameters.cron ?? '') })
      } else if (node.type === 'manualTrigger') {
        triggers.push({ type: 'manual', nodeId: node.id })
      }
    }
    return triggers
  }

  /** Register webhook + cron triggers for an active workflow. */
  register(workflow: WorkflowRecord): { webhooks: WebhookRoute[]; crons: string[] } {
    this.unregister(workflow.id)
    const webhooks: WebhookRoute[] = []
    const crons: string[] = []

    for (const t of this.extractTriggers(workflow)) {
      if (t.type === 'webhook' && t.path) {
        const node = workflow.nodes.find((n) => n.id === t.nodeId)
        const secret =
          String(node?.parameters?.hmacSecret ?? '') ||
          (workflow.settings as Record<string, any>)?.webhookSecrets?.[t.nodeId] ||
          undefined
        const route: WebhookRoute = {
          workflowId: workflow.id,
          nodeId: t.nodeId,
          path: t.path,
          method: t.method ?? 'POST',
          hmacSecret: secret,
        }
        this.webhooks.set(`${workflow.id}:${t.path}`, route)
        webhooks.push(route)
      } else if (t.type === 'schedule' && t.cron && cron.validate(t.cron)) {
        const task = cron.schedule(t.cron, async () => {
          await this.fireCron(workflow.id, t.nodeId, t.cron!)
        })
        this.cronTasks.set(t.nodeId, [...(this.cronTasks.get(t.nodeId) ?? []), task])
        crons.push(t.cron)
      }
    }
    return { webhooks, crons }
  }

  unregister(workflowId: string): void {
    for (const key of [...this.webhooks.keys()]) {
      if (key.startsWith(`${workflowId}:`)) this.webhooks.delete(key)
    }
    for (const [nodeId, tasks] of [...this.cronTasks]) {
      for (const task of tasks) task.stop()
      this.cronTasks.delete(nodeId)
    }
  }

  private async fireCron(workflowId: string, nodeId: string, cronExpr: string): Promise<void> {
    const workflow = await this.store.getWorkflow(workflowId)
    if (!workflow?.active) return
    const result = await executeWorkflow(this.store, {
      workflow,
      mode: 'production',
      trigger: { nodeId, type: 'schedule', payload: { cron: cronExpr, firedAt: new Date().toISOString() } },
    })
    const now = new Date().toISOString()
    const record = await this.store.createExecution({
      workflowId,
      status: result.status,
      mode: 'production',
      trigger: { nodeId, type: 'schedule', payload: { cron: cronExpr } },
      nodeRuns: result.nodeRuns,
      error: result.error,
      startedAt: now,
      finishedAt: now,
      durationMs: result.nodeRuns.reduce((a, n) => a + n.durationMs, 0),
    })
    this.onExecutionStarted(record)
  }

  /** Boot-time: re-register every active workflow (e.g. after a restart). */
  async registerAllActive(): Promise<void> {
    const workflows = await this.store.listWorkflows()
    let count = 0
    for (const wf of workflows) {
      if (wf.active) {
        this.register(wf)
        count++
      }
    }
    if (count > 0) console.log(`[triggers] registered triggers for ${count} active workflow(s)`)
  }
}

export interface ExecutionLike {
  id: string
  workflowId: string
  status: string
  mode: string
}
