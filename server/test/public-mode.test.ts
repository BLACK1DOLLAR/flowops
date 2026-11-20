import { describe, expect, it } from 'vitest'
import { edge, fakeStore, node, trigger, workflow } from './helpers.js'

// config is read when the module loads, so set the flag before importing the engine.
process.env.PUBLIC_ACCESS = 'true'
const { config } = await import('../src/config.js')
const { executeWorkflow } = await import('../src/engine/dag.js')

describe('PUBLIC_ACCESS mode', () => {
  it('drops the API token requirement', () => {
    expect(config.publicAccess).toBe(true)
    expect(config.apiToken).toBe('')
  })

  it('refuses to run the Code node', async () => {
    const wf = workflow([trigger(), node('c', 'code', { jsCode: 'return [{ json: { pwned: process.env } }]' })], [edge('t', 'c')])
    const res = await executeWorkflow(fakeStore(), { workflow: wf, mode: 'manual' })
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/Code node is turned off on this public server/)
  })

  it('still runs the other nodes', async () => {
    const wf = workflow([trigger(), node('s', 'set', { fields: { ok: true } })], [edge('t', 's')])
    const res = await executeWorkflow(fakeStore(), { workflow: wf, mode: 'manual' })
    expect(res.status).toBe('success')
  })
})
