// Safe expression evaluator for {{ ... }} templates.
// Supports: property access, indexing, method calls on values, literals,
// ternary, || &&, == != === !==, comparisons, + - * / %, unary ! -,
// and whitelisted globals (Math, JSON, Number, String, Boolean, Array, Object).
// No assignments, no member access to __proto__/constructor, no arbitrary code.

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punc'; v: string }

const OPS3 = ['===', '!==']
const OPS2 = ['==', '!=', '>=', '<=', '&&', '||']
const OPS1 = ['+', '-', '*', '/', '%', '<', '>', '!']
const GLOBALS: Record<string, unknown> = {
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object,
  parseInt,
  parseFloat,
  isNaN,
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9._]/.test(src[j])) j++
      tokens.push({ t: 'num', v: Number(src.slice(i, j).replace(/_/g, '')) })
      i = j
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          out += src[j + 1] === 'n' ? '\n' : src[j + 1]
          j += 2
        } else out += src[j++]
      }
      if (j >= src.length) throw new Error('Unterminated string in expression')
      tokens.push({ t: 'str', v: out })
      i = j + 1
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < src.length && /[\w$]/.test(src[j])) j++
      tokens.push({ t: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }
    const three = src.slice(i, i + 3)
    if (OPS3.includes(three)) {
      tokens.push({ t: 'op', v: three })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      tokens.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if (OPS1.includes(c)) {
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    if ('()[],.:?'.includes(c)) {
      tokens.push({ t: 'punc', v: c })
      i++
      continue
    }
    throw new Error(`Unexpected character "${c}" in expression`)
  }
  return tokens
}

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])

class Parser {
  private pos = 0
  constructor(private tokens: Token[], private ctx: Record<string, unknown>) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }
  private next(): Token {
    const t = this.tokens[this.pos++]
    if (!t) throw new Error('Unexpected end of expression')
    return t
  }
  private eatOp(v: string): boolean {
    const t = this.peek()
    if (t && t.t === 'op' && t.v === v) {
      this.pos++
      return true
    }
    return false
  }
  private eatPunc(v: string): boolean {
    const t = this.peek()
    if (t && t.t === 'punc' && t.v === v) {
      this.pos++
      return true
    }
    return false
  }

  parse(): unknown {
    const v = this.ternary()
    if (this.pos < this.tokens.length) throw new Error('Unexpected trailing tokens in expression')
    return v
  }

  private ternary(): unknown {
    const cond = this.or()
    if (this.eatPunc('?')) {
      const a = this.ternary()
      if (!this.eatPunc(':')) throw new Error('Expected ":" in ternary')
      const b = this.ternary()
      return cond ? a : b
    }
    return cond
  }
  private or(): unknown {
    let left = this.and()
    while (this.eatOp('||')) left = left || this.and() // eslint-disable-line
    return left
  }
  private and(): unknown {
    let left = this.equality()
    while (this.eatOp('&&')) left = left && this.equality() // eslint-disable-line
    return left
  }
  private equality(): unknown {
    let left = this.comparison()
    for (;;) {
      if (this.eatOp('==')) left = left == this.comparison() // eslint-disable-line
      else if (this.eatOp('!=')) left = left != this.comparison() // eslint-disable-line
      else if (this.eatOp('===')) left = left === this.comparison()
      else if (this.eatOp('!==')) left = left !== this.comparison()
      else return left
    }
  }
  private comparison(): unknown {
    let left = this.additive()
    for (;;) {
      if (this.eatOp('<')) left = (left as number) < (this.additive() as number)
      else if (this.eatOp('>')) left = (left as number) > (this.additive() as number)
      else if (this.eatOp('<=')) left = (left as number) <= (this.additive() as number)
      else if (this.eatOp('>=')) left = (left as number) >= (this.additive() as number)
      else return left
    }
  }
  private additive(): unknown {
    let left = this.multiplicative()
    for (;;) {
      if (this.eatOp('+')) left = (left as any) + (this.multiplicative() as any)
      else if (this.eatOp('-')) left = (left as number) - (this.multiplicative() as number)
      else return left
    }
  }
  private multiplicative(): unknown {
    let left = this.unary()
    for (;;) {
      if (this.eatOp('*')) left = (left as number) * (this.unary() as number)
      else if (this.eatOp('/')) left = (left as number) / (this.unary() as number)
      else if (this.eatOp('%')) left = (left as number) % (this.unary() as number)
      else return left
    }
  }
  private unary(): unknown {
    if (this.eatOp('!')) return !this.unary()
    if (this.eatOp('-')) return -(this.unary() as number)
    return this.primary()
  }

  private primary(): unknown {
    const t = this.next()
    let value: unknown
    if (t.t === 'num' || t.t === 'str') value = t.v
    else if (t.t === 'ident') {
      if (t.v === 'true') value = true
      else if (t.v === 'false') value = false
      else if (t.v === 'null') value = null
      else if (t.v in this.ctx) value = this.ctx[t.v]
      else if (t.v in GLOBALS) value = GLOBALS[t.v]
      else throw new Error(`Unknown identifier "${t.v}" in expression`)
    } else if (t.t === 'punc' && t.v === '(') {
      value = this.ternary()
      if (!this.eatPunc(')')) throw new Error('Expected ")"')
    } else {
      throw new Error(`Unexpected token in expression`)
    }
    return this.postfix(value)
  }

  private postfix(base: unknown): unknown {
    let value = base
    // Remember the object a property was read from, so method calls such as
    // `$json.name.toUpperCase()` or `$now.format('D MMM')` keep their `this`.
    let receiver: unknown = undefined
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'punc' && t.v === '.') {
        this.pos++
        const id = this.next()
        if (id.t !== 'ident') throw new Error('Expected property name after "."')
        if (BLOCKED.has(id.v)) throw new Error(`Access to "${id.v}" is blocked`)
        receiver = value
        value = (value as any)?.[id.v]
      } else if (t && t.t === 'punc' && t.v === '[') {
        this.pos++
        const idx = this.ternary()
        if (!this.eatPunc(']')) throw new Error('Expected "]"')
        if (typeof idx === 'string' && BLOCKED.has(idx)) throw new Error(`Access to "${idx}" is blocked`)
        receiver = value
        value = (value as Record<string | number, unknown>)?.[idx as string | number]
      } else if (t && t.t === 'punc' && t.v === '(') {
        this.pos++
        const args: unknown[] = []
        if (!this.eatPunc(')')) {
          do {
            args.push(this.ternary())
          } while (this.eatPunc(',') && !this.eatPunc(')'))
          if (!this.eatPunc(')')) throw new Error('Expected ")" after arguments')
        }
        if (typeof value !== 'function') {
          throw new Error(
            receiver === undefined
              ? 'Expression tried to call a non-function'
              : `Expression tried to call a non-function (no such method on ${describe(receiver)})`,
          )
        }
        value = Reflect.apply(value as (...a: unknown[]) => unknown, receiver, args)
        receiver = undefined
      } else {
        return value
      }
    }
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v instanceof String) return 'a date/string value'
  if (Array.isArray(v)) return 'an array'
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`
}

// ---------------------------------------------------------------------------
// $now: an ISO-timestamp string that also has date helpers.
//   {{ $now }}                         -> "2026-11-19T06:00:00.000Z"
//   {{ $now.format('dddd, MMMM D') }}  -> "Thursday, November 19"
//   {{ $now.format('YYYY-MM-DD HH:mm') }}
//   {{ $now.plus(1, 'day').format('ddd D MMM') }}
// Tokens: YYYY YY MMMM MMM MM M dddd ddd DD D HH H hh h mm ss A a, [literal]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatDate(d: Date, pattern: string): string {
  return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A|a/g, (tok, literal) => {
    if (literal !== undefined) return literal
    const h12 = d.getHours() % 12 || 12
    switch (tok) {
      case 'YYYY': return String(d.getFullYear())
      case 'YY': return pad(d.getFullYear() % 100)
      case 'MMMM': return MONTHS[d.getMonth()]
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3)
      case 'MM': return pad(d.getMonth() + 1)
      case 'M': return String(d.getMonth() + 1)
      case 'dddd': return DAYS[d.getDay()]
      case 'ddd': return DAYS[d.getDay()].slice(0, 3)
      case 'DD': return pad(d.getDate())
      case 'D': return String(d.getDate())
      case 'HH': return pad(d.getHours())
      case 'H': return String(d.getHours())
      case 'hh': return pad(h12)
      case 'h': return String(h12)
      case 'mm': return pad(d.getMinutes())
      case 'ss': return pad(d.getSeconds())
      case 'A': return d.getHours() < 12 ? 'AM' : 'PM'
      case 'a': return d.getHours() < 12 ? 'am' : 'pm'
      default: return tok
    }
  })
}

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }

export function makeDateValue(date: Date = new Date()): String {
  const v = new String(date.toISOString()) as String & Record<string, unknown>
  const shift = (n: number, unit: string) => {
    const u = String(unit).replace(/s$/, '')
    if (!(u in UNIT_MS)) throw new Error(`Unknown unit "${unit}" (use minute, hour, day or week)`)
    return makeDateValue(new Date(date.getTime() + Number(n) * UNIT_MS[u]))
  }
  Object.assign(v, {
    format: (pattern = 'YYYY-MM-DD') => formatDate(date, String(pattern)),
    toISO: () => date.toISOString(),
    toDate: () => new Date(date.getTime()),
    plus: (n: number, unit = 'day') => shift(n, unit),
    minus: (n: number, unit = 'day') => shift(-n, unit),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: DAYS[date.getDay()],
    hour: date.getHours(),
    minute: date.getMinutes(),
  })
  return v
}

/** Unwrap boxed values (like $now) so outputs are plain strings. */
const unbox = (v: unknown): unknown => (v instanceof String ? v.valueOf() : v)

const EXPR_RE = /\{\{\s*([\s\S]+?)\s*\}\}/g

/** Evaluate a single {{ }} expression against the given context. */
export function evaluateExpression(expr: string, ctx: Record<string, unknown>): unknown {
  const tokens = tokenize(expr)
  if (tokens.length === 0) return ''
  return new Parser(tokens, ctx).parse()
}

/**
 * Interpolate a template string: replaces every {{ expr }} with its evaluated
 * value. Strings that consist of exactly one expression return the raw value
 * (preserving types); otherwise results are stringified in place.
 */
export function interpolate(template: string, ctx: Record<string, unknown>): unknown {
  const whole = template.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/)
  if (whole) return unbox(evaluateExpression(whole[1], ctx))

  return template.replace(EXPR_RE, (_m, expr) => {
    const v = unbox(evaluateExpression(expr, ctx))
    if (v === null || v === undefined) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}

/** Deeply interpolate every string value in a params object. */
export function interpolateParams<T>(params: Record<string, unknown>, ctx: Record<string, unknown>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return interpolate(v, ctx)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    return v
  }
  return walk(params) as T
}
