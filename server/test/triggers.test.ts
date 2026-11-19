import { afterEach, describe, expect, it } from 'vitest'
import { TriggerManager } from '../src/triggers.js'
import { fakeStore, node, workflow } from './helpers.js'

const scheduled = (id: string, parameters: Record<string, unknown> = { cron: '0 8 * * *' }) => ({
  ...workflow([node('s', 'schedule', parameters)], []),
  id,
  active: true,
})

describe('trigger manager', () => {
  const tm = new TriggerManager(fakeStore(), () => {})
  const tasks = (id: string) => ((tm as any).cronTasks as Map<string, unknown[]>).get(id)?.length ?? 0
  afterEach(() => {
    tm.unregister('a')
    tm.unregister('b')
  })

  it("re-registering one workflow keeps other workflows' schedules", () => {
    tm.register(scheduled('a'))
    tm.register(scheduled('b'))
    tm.register(scheduled('a')) // e.g. saving workflow a while it is active
    expect(tasks('a')).toBe(1)
    expect(tasks('b')).toBe(1)
    tm.unregister('a')
    expect(tasks('a')).toBe(0)
    expect(tasks('b')).toBe(1)
  })

  it('applies the schedule timezone and reports bad input', () => {
    expect(tm.register(scheduled('a', { cron: '0 8 * * *', timezone: 'Europe/London' })).crons).toEqual(['0 8 * * * (Europe/London)'])
    expect(tm.register(scheduled('b', { cron: 'not a cron' })).errors[0]).toMatch(/Invalid cron/)
  })

  it('records the webhook response mode and signing credential', () => {
    const wf = { ...workflow([node('w', 'webhook', { path: 'orders', responseMode: 'responseNode' }, { credentials: { webhookHmac: 'cred1' } })], []), id: 'a', active: true }
    const [route] = tm.register(wf).webhooks
    expect(route).toMatchObject({ path: 'orders', responseMode: 'responseNode', hmacCredentialId: 'cred1' })
  })
})
