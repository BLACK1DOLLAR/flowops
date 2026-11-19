import cron, { type ScheduledTask } from 'node-cron'
import type { Store, TriggerInfo, WorkflowRecord } from './store/types.js'
import { runAndRecord } from './runner.js'

export interface WebhookRoute {
  workflowId: string
  nodeId: string
  path: string
  method: string
  /** Legacy: secret typed directly into the node. Prefer `hmacCredentialId`. */
  hmacSecret?: string
  /** Id of an encrypted `hmacSecret` credential. */
  hmacCredentialId?: string
  /** immediately | lastNode | responseNode */
  responseMode: string
}

/**
 * Registers/unregisters live triggers: HTTP webhook routes and cron schedules.
 * Called whenever a workflow is activated, deactivated or saved while active.
 */
export class TriggerManager {
  private webhooks = new Map<string, WebhookRoute>() // `${workflowId}:${path}` -> route
  private cronTasks = new Map<string, ScheduledTask[]>() // workflowId -> tasks

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
      if (node.disabled) continue
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
  register(workflow: WorkflowRecord): { webhooks: WebhookRoute[]; crons: string[]; errors: string[] } {
    this.unregister(workflow.id)
    const webhooks: WebhookRoute[] = []
    const crons: string[] = []
    const errors: string[] = []
    const tasks: ScheduledTask[] = []

    for (const t of this.extractTriggers(workflow)) {
      const node = workflow.nodes.find((n) => n.id === t.nodeId)
      if (t.type === 'webhook' && t.path) {
        const route: WebhookRoute = {
          workflowId: workflow.id,
          nodeId: t.nodeId,
          path: t.path,
          method: t.method ?? 'POST',
          hmacSecret:
            String(node?.parameters?.hmacSecret ?? '') ||
            (workflow.settings as Record<string, any>)?.webhookSecrets?.[t.nodeId] ||
            undefined,
          hmacCredentialId: node?.credentials?.webhookHmac || undefined,
          responseMode: String(node?.parameters?.responseMode ?? 'immediately'),
        }
        this.webhooks.set(`${workflow.id}:${t.path}`, route)
        webhooks.push(route)
      } else if (t.type === 'schedule' && t.cron) {
        if (!cron.validate(t.cron)) {
          errors.push(`Invalid cron expression "${t.cron}"`)
          continue
        }
        const timezone =
          String(node?.parameters?.timezone ?? '') || String((workflow.settings as Record<string, unknown>)?.timezone ?? '') || undefined
        try {
          const task = cron.schedule(t.cron, () => this.fireCron(workflow.id, t.nodeId, t.cron!), timezone ? { timezone } : undefined)
          tasks.push(task)
          crons.push(timezone ? `${t.cron} (${timezone})` : t.cron)
        } catch (err) {
          errors.push(`Schedule "${t.cron}": ${(err as Error).message}`)
        }
      }
    }
    if (tasks.length) this.cronTasks.set(workflow.id, tasks)
    return { webhooks, crons, errors }
  }

  unregister(workflowId: string): void {
    for (const key of [...this.webhooks.keys()]) {
      if (key.startsWith(`${workflowId}:`)) this.webhooks.delete(key)
    }
    for (const task of this.cronTasks.get(workflowId) ?? []) task.stop()
    this.cronTasks.delete(workflowId)
  }

  private async fireCron(workflowId: string, nodeId: string, cronExpr: string): Promise<void> {
    try {
      const workflow = await this.store.getWorkflow(workflowId)
      if (!workflow?.active) return
      const { execution } = await runAndRecord(this.store, workflow, 'production', {
        trigger: { nodeId, type: 'schedule', payload: { cron: cronExpr, firedAt: new Date().toISOString() } },
      })
      this.onExecutionStarted(execution)
    } catch (err) {
      console.error(`[triggers] scheduled run of ${workflowId} failed:`, err)
    }
  }

  /** Boot-time: re-register every active workflow (e.g. after a restart). */
  async registerAllActive(): Promise<void> {
    const workflows = await this.store.listWorkflows()
    let count = 0
    for (const wf of workflows) {
      if (wf.active) {
        const { errors } = this.register(wf)
        for (const e of errors) console.warn(`[triggers] ${wf.name}: ${e}`)
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
