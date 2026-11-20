import { describe, expect, it } from 'vitest'
import { executeWorkflow } from '../src/engine/dag.js'
import { edge, fakeStore, node, source, trigger, workflow } from './helpers.js'

const store = fakeStore()
const run = (wf: ReturnType<typeof workflow>, extra: Partial<Parameters<typeof executeWorkflow>[1]> = {}) =>
  executeWorkflow(store, { workflow: wf, mode: 'manual', ...extra })
const outputOf = (res: Awaited<ReturnType<typeof run>>, id: string, idx = 0) =>
  [...res.nodeRuns].reverse().find((r) => r.nodeId === id)?.output?.[idx]?.map((i) => i.json)

describe('engine: routing', () => {
  it('routes IF items and skips the dead branch', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ n: 1 }, { n: 5 }]), node('if', 'if', { left: '{{ $json.n }}', operator: 'gt', right: '3' }), node('yes', 'noOp'), node('no', 'noOp')],
      [edge('t', 'src'), edge('src', 'if'), edge('if', 'yes', 0), edge('if', 'no', 1)],
    )
    const res = await run(wf)
    expect(outputOf(res, 'if', 0)).toEqual([{ n: 5 }])
    expect(outputOf(res, 'if', 1)).toEqual([{ n: 1 }])
  })

  it('runs a node wired to two triggers when only one of them fires', async () => {
    const wf = workflow(
      [node('hook', 'webhook'), node('cron', 'schedule', { cron: '* * * * *' }), node('mark', 'set', { fields: { ran: true } })],
      [edge('hook', 'mark'), edge('cron', 'mark')],
    )
    const res = await executeWorkflow(store, { workflow: wf, mode: 'production', trigger: { nodeId: 'hook', type: 'webhook', payload: { body: { a: 1 } } } })
    expect(res.status).toBe('success')
    expect(outputOf(res, 'mark')?.[0]).toMatchObject({ body: { a: 1 }, ran: true })
  })

  it('still waits for both branches of the same trigger at a Merge', async () => {
    const wf = workflow(
      [trigger(), source('a', [{ a: 1 }]), source('b', [{ b: 2 }]), node('m', 'merge', { mode: 'combine' })],
      [edge('t', 'a'), edge('t', 'b'), edge('a', 'm', 0, 0), edge('b', 'm', 0, 1)],
    )
    const res = await run(wf)
    expect(res.nodeRuns.filter((r) => r.nodeId === 'm')).toHaveLength(1)
    expect(outputOf(res, 'm')).toEqual([{ a: 1, b: 2 }])
  })

  it('feeds error-workflow input items to the start node', async () => {
    const wf = workflow([trigger(), node('c', 'code', { jsCode: 'return $input.all()' })], [edge('t', 'c')])
    const res = await executeWorkflow(store, { workflow: wf, mode: 'production', inputItems: [{ json: { error: 'boom' } }] })
    expect(outputOf(res, 'c')).toEqual([{ error: 'boom' }])
  })
})

describe('engine: $("Node") references', () => {
  it('reads an earlier node output by name, paired by item index', async () => {
    const wf = workflow(
      [
        trigger(),
        source('orders', [{ id: 'a', email: 'x@y.z' }, { id: 'b', email: 'p@q.r' }]),
        node('shape', 'set', { fields: { only: 'yes' }, keepOnlySet: true }),
        node('use', 'set', { fields: { email: "{{ $('orders').item.json.email }}" } }),
      ],
      [edge('t', 'orders'), edge('orders', 'shape'), edge('shape', 'use')],
    )
    const res = await run(wf)
    expect(res.status).toBe('success')
    expect(outputOf(res, 'use')).toEqual([{ only: 'yes', email: 'x@y.z' }, { only: 'yes', email: 'p@q.r' }])
  })

  it('gives a clear error for an unknown node name', async () => {
    const wf = workflow([trigger(), node('use', 'set', { fields: { x: "{{ $('Nope').json.a }}" } })], [edge('t', 'use')])
    const res = await run(wf)
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/No data from node "Nope"/)
  })
})

describe('engine: error handling', () => {
  const failing = (settings: Record<string, unknown>) =>
    node('bad', 'code', { jsCode: "throw new Error('nope')" }, { settings })

  it('stops the branch by default', async () => {
    const wf = workflow([trigger(), failing({}), node('after', 'noOp')], [edge('t', 'bad'), edge('bad', 'after')])
    const res = await run(wf)
    expect(res.status).toBe('error')
    expect(res.nodeRuns.find((r) => r.nodeId === 'after')?.status).toBe('skipped')
  })

  it('retries the configured number of times', async () => {
    const wf = workflow([trigger(), failing({ retryOnFail: true, maxTries: 3, waitBetweenTries: 0 })], [edge('t', 'bad')])
    const res = await run(wf)
    const bad = res.nodeRuns.find((r) => r.nodeId === 'bad')!
    expect(bad.error).toMatch(/after 3 attempts/)
    expect(bad.logs?.filter((l) => l.startsWith('[retry]'))).toHaveLength(2)
  })

  it('continues with an error field when onError = continue', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ a: 1 }]), failing({ onError: 'continue' }), node('after', 'set', { fields: {} })],
      [edge('t', 'src'), edge('src', 'bad'), edge('bad', 'after')],
    )
    const res = await run(wf)
    expect(res.status).toBe('success')
    expect(outputOf(res, 'after')).toEqual([{ a: 1, error: expect.stringContaining('nope') }])
  })

  it('sends failed items to the error output when onError = errorOutput', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ a: 1 }]), failing({ onError: 'errorOutput' }), node('ok', 'set', { fields: {} }), node('err', 'set', { fields: {} })],
      [edge('t', 'src'), edge('src', 'bad'), edge('bad', 'ok', 0), edge('bad', 'err', 1)],
    )
    const res = await run(wf)
    expect(res.status).toBe('success')
    expect(res.nodeRuns.find((r) => r.nodeId === 'ok')?.status).toBe('skipped')
    expect(outputOf(res, 'err')?.[0]).toMatchObject({ a: 1 })
  })
})

describe('engine: loop over items', () => {
  it('runs the body once per batch and emits all results on "done"', async () => {
    const wf = workflow(
      [
        trigger(),
        source('src', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]),
        node('loop', 'loopOverItems', { batchSize: 2 }),
        node('double', 'code', { mode: 'runOnceForEachItem', jsCode: 'return { n: $json.n * 2 }' }),
        node('after', 'set', { fields: {} }),
      ],
      [edge('t', 'src'), edge('src', 'loop'), edge('loop', 'double', 1), edge('double', 'loop'), edge('loop', 'after', 0)],
    )
    const res = await run(wf)
    expect(res.status).toBe('success')
    expect(res.nodeRuns.filter((r) => r.nodeId === 'double')).toHaveLength(3) // batches of 2, 2, 1
    expect(outputOf(res, 'after')).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }, { n: 8 }, { n: 10 }])
  })

  it('passes everything through when nothing loops back', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ n: 1 }, { n: 2 }]), node('loop', 'loopOverItems', { batchSize: 1 }), node('after', 'set', { fields: {} })],
      [edge('t', 'src'), edge('src', 'loop'), edge('loop', 'after', 0)],
    )
    const res = await run(wf)
    expect(outputOf(res, 'after')).toEqual([{ n: 1 }, { n: 2 }])
  })
})

describe('engine: wait and resume', () => {
  it('pauses on a long wait and resumes from saved state', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ v: 1 }]), node('wait', 'wait', { resume: 'afterTime', amount: 2, unit: 'hours' }), node('after', 'set', { fields: { done: true } })],
      [edge('t', 'src'), edge('src', 'wait'), edge('wait', 'after')],
    )
    const first = await run(wf)
    expect(first.status).toBe('waiting')
    expect(new Date(first.waitTill!).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    expect(first.nodeRuns.find((r) => r.nodeId === 'after')).toBeUndefined()

    const state = JSON.parse(JSON.stringify(first.resumeState)) // must survive a database round trip
    const second = await executeWorkflow(store, { workflow: wf, mode: 'manual', resume: { state } })
    expect(second.status).toBe('success')
    expect(outputOf(second, 'after')).toEqual([{ v: 1, done: true }])
    expect(second.nodeRuns.filter((r) => r.nodeId === 'wait').map((r) => r.status)).toEqual(['success'])
  })

  it('uses the resume-webhook payload as the wait output', async () => {
    const wf = workflow(
      [trigger(), node('wait', 'wait', { resume: 'webhook' }), node('after', 'set', { fields: {} })],
      [edge('t', 'wait'), edge('wait', 'after')],
    )
    const first = await run(wf, { executionId: 'exec-1' })
    expect(first.status).toBe('waiting')
    expect(first.waitTill).toBeUndefined()
    const second = await executeWorkflow(store, { workflow: wf, mode: 'manual', resume: { state: first.resumeState!, data: { approved: true } } })
    expect(outputOf(second, 'after')).toEqual([{ approved: true }])
  })

  it('runs short waits inline', async () => {
    const wf = workflow([trigger(), node('wait', 'wait', { resume: 'afterTime', amount: 0, unit: 'seconds' })], [edge('t', 'wait')])
    expect((await run(wf)).status).toBe('success')
  })
})

describe('engine: pinned data', () => {
  it('uses pinned output in manual runs but not in production', async () => {
    const pinned = node('http', 'code', { jsCode: "throw new Error('would call the API')" }, { pinData: [{ json: { pinned: true } }] })
    const wf = workflow([trigger(), pinned], [edge('t', 'http')])
    expect(outputOf(await run(wf), 'http')).toEqual([{ pinned: true }])
    const prod = await executeWorkflow(store, { workflow: wf, mode: 'production' })
    expect(prod.status).toBe('error')
  })
})
