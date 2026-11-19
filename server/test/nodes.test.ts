import { describe, expect, it } from 'vitest'
import { executeWorkflow } from '../src/engine/dag.js'
import { planWait, type NodeExecContext } from '../src/engine/nodes.js'
import { edge, fakeStore, node, source, trigger, workflow } from './helpers.js'

async function runNode(type: string, params: Record<string, unknown>, rows: unknown[]) {
  const wf = workflow([trigger(), source('src', rows), node('n', type, params)], [edge('t', 'src'), edge('src', 'n')])
  const res = await executeWorkflow(fakeStore(), { workflow: wf, mode: 'manual' })
  const run = res.nodeRuns.find((r) => r.nodeId === 'n')!
  if (run.status === 'error') throw new Error(run.error)
  return run.output[0].map((i) => i.json)
}

describe('data nodes', () => {
  it('set: adds fields (with dot paths and expressions) or keeps only them', async () => {
    expect(await runNode('set', { fields: { 'user.name': '{{ $json.first }}', n: '{{ $json.n * 2 }}' } }, [{ first: 'Ada', n: 2 }]))
      .toEqual([{ first: 'Ada', n: 4, user: { name: 'Ada' } }])
    expect(await runNode('set', { fields: { x: 1 }, keepOnlySet: true }, [{ a: 1 }])).toEqual([{ x: 1 }])
  })

  it('filter keeps matching items', async () => {
    expect(await runNode('filter', { left: '{{ $json.status }}', operator: 'equals', right: 'paid' }, [{ status: 'paid' }, { status: 'open' }]))
      .toEqual([{ status: 'paid' }])
  })

  it('sort orders numbers numerically, either direction', async () => {
    const rows = [{ v: 10 }, { v: 9 }, { v: 100 }]
    expect(await runNode('sort', { field: 'v', order: 'asc' }, rows)).toEqual([{ v: 9 }, { v: 10 }, { v: 100 }])
    expect(await runNode('sort', { field: 'v', order: 'desc' }, rows)).toEqual([{ v: 100 }, { v: 10 }, { v: 9 }])
  })

  it('limit keeps the first or last N', async () => {
    const rows = [{ i: 1 }, { i: 2 }, { i: 3 }]
    expect(await runNode('limit', { maxItems: 2 }, rows)).toEqual([{ i: 1 }, { i: 2 }])
    expect(await runNode('limit', { maxItems: 2, keep: 'last' }, rows)).toEqual([{ i: 2 }, { i: 3 }])
  })

  it('removeDuplicates by field or whole item', async () => {
    expect(await runNode('removeDuplicates', { field: 'email' }, [{ email: 'a', n: 1 }, { email: 'a', n: 2 }, { email: 'b' }]))
      .toEqual([{ email: 'a', n: 1 }, { email: 'b' }])
    expect(await runNode('removeDuplicates', {}, [{ a: 1 }, { a: 1 }])).toEqual([{ a: 1 }])
  })

  it('splitOut turns an array field into items', async () => {
    expect(await runNode('splitOut', { field: 'body.tags' }, [{ body: { tags: ['x', 'y'] } }])).toEqual([{ tags: 'x' }, { tags: 'y' }])
    expect(await runNode('splitOut', { field: 'rows', include: 'allOtherFields' }, [{ id: 7, rows: [{ a: 1 }] }]))
      .toEqual([{ id: 7, rows: [{ a: 1 }], a: 1 }])
  })

  it('aggregate collects a field or all items', async () => {
    expect(await runNode('aggregate', { mode: 'field', field: 'id', outputField: 'ids' }, [{ id: 1 }, { id: 2 }])).toEqual([{ ids: [1, 2] }])
    expect(await runNode('aggregate', { mode: 'allItems' }, [{ id: 1 }, { id: 2 }])).toEqual([{ items: [{ id: 1 }, { id: 2 }] }])
  })
})

describe('respond to webhook', () => {
  it('sends the configured response to the waiting caller', async () => {
    const wf = workflow(
      [trigger(), source('src', [{ ok: true }]), node('r', 'respondToWebhook', { statusCode: 201, respondWith: 'firstItem', headers: { 'X-A': '1' } })],
      [edge('t', 'src'), edge('src', 'r')],
    )
    let response: unknown
    await executeWorkflow(fakeStore(), { workflow: wf, mode: 'production', onResponse: (r) => (response = r) })
    expect(response).toEqual({ statusCode: 201, headers: { 'X-A': '1' }, body: { ok: true } })
  })
})

describe('wait planning', () => {
  const ctx = (parameters: Record<string, unknown>) =>
    ({ node: node('w', 'wait', parameters), items: [{ json: {} }], inputs: [], mode: 'manual', logs: [], getCredential: async () => null, store: fakeStore() }) as NodeExecContext

  it('runs short waits inline and persists long ones', () => {
    expect(planWait(ctx({ resume: 'afterTime', amount: 2, unit: 'seconds' }))).toEqual({ persist: false, ms: 2000 })
    expect(planWait(ctx({ resume: 'afterTime', amount: 1, unit: 'days' })).persist).toBe(true)
    expect(planWait(ctx({ resume: 'webhook' }))).toEqual({ persist: true })
  })

  it('keeps the old millisecond parameter working', () => {
    expect(planWait(ctx({ ms: 1500 }))).toEqual({ persist: false, ms: 1500 })
  })

  it('rejects an invalid date', () => {
    expect(() => planWait(ctx({ resume: 'atTime', dateTime: 'soon' }))).toThrow(/not a valid date/)
  })
})
