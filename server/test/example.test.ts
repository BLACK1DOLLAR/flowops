import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeWorkflow } from '../src/engine/dag.js'
import type { WorkflowRecord } from '../src/store/types.js'
import { fakeStore } from './helpers.js'

describe('bundled example', () => {
  it('runs the morning-brief workflow end to end with no credentials', async () => {
    process.env.OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'flowops-outbox-'))
    const wf = JSON.parse(readFileSync(new URL('../../tests/morning-brief-workflow.json', import.meta.url), 'utf8'))
    const workflow: WorkflowRecord = { id: 'brief', active: false, settings: {}, tags: [], createdAt: '', updatedAt: '', ...wf }
    const res = await executeWorkflow(fakeStore(), { workflow, mode: 'manual' })
    expect(res.error).toBeUndefined()
    expect(res.status).toBe('success')
    const email = res.nodeRuns.find((r) => r.nodeType === 'emailSend')
    expect(email?.output[0][0].json).toMatchObject({ sent: false, transport: 'outbox' })
  }, 20000)
})
