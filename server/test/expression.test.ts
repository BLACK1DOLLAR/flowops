import { describe, expect, it } from 'vitest'
import { evaluateExpression, formatDate, interpolate } from '../src/expression.js'

describe('expressions', () => {
  it('reads nested values and keeps types for whole-expression templates', () => {
    const ctx = { $json: { body: { email: 'a@b.co', count: 3 } } }
    expect(interpolate('{{ $json.body.count }}', ctx)).toBe(3)
    expect(interpolate('Hi {{ $json.body.email }}!', ctx)).toBe('Hi a@b.co!')
  })

  it('supports ternaries, comparisons and method calls with the right receiver', () => {
    const ctx = { $json: { name: 'ada', n: 5 } }
    expect(evaluateExpression("$json.n > 3 ? 'big' : 'small'", ctx)).toBe('big')
    expect(evaluateExpression('$json.name.toUpperCase()', ctx)).toBe('ADA')
  })

  it('calls functions from the context, e.g. $("Node")', () => {
    const ctx = { $: (name: string) => ({ json: { from: name } }) }
    expect(evaluateExpression("$('Webhook').json.from", ctx)).toBe('Webhook')
  })

  it('blocks prototype access', () => {
    expect(() => evaluateExpression('$json.constructor', { $json: {} })).toThrow(/blocked/)
    expect(() => evaluateExpression("$json['__proto__']", { $json: {} })).toThrow(/blocked/)
  })

  it('rejects unknown identifiers instead of reaching globals', () => {
    expect(() => evaluateExpression('process.env', {})).toThrow(/Unknown identifier/)
  })

  it('formats dates', () => {
    expect(formatDate(new Date(2026, 10, 19, 8, 5), 'dddd, MMMM D [at] HH:mm')).toBe('Thursday, November 19 at 08:05')
  })
})
