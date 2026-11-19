import vm from 'node:vm'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Store } from '../store/types.js'
import type { Item, WorkflowNode } from '../store/types.js'
import { interpolate, interpolateParams, makeDateValue } from '../expression.js'
import { config } from '../config.js'

export interface WebhookResponse {
  statusCode: number
  headers: Record<string, string>
  body: unknown
}

export interface NodeExecContext {
  node: WorkflowNode
  items: Item[]
  inputs: Item[][] // items delivered per input index
  trigger?: unknown // trigger payload (webhook body, cron fire, manual input)
  mode: 'manual' | 'test' | 'production' | 'retry'
  logs: string[] // handler can push console output for the execution log
  getCredential: (id: string) => Promise<{ type: string; data: Record<string, string> } | null>
  store: Store
  executionId?: string
  /** Latest output of every node that has run so far, keyed by node name (for `$('Name')`). */
  runData?: Record<string, Item[][]>
  /** Set when a webhook caller is waiting for a "Respond to Webhook" node. */
  respond?: (response: WebhookResponse) => void
}

export type NodeHandler = (ctx: NodeExecContext) => Promise<Item[][]>

const j = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v }

const out = (json: unknown): Item[] => (Array.isArray(json) ? json.map((x) => ({ json: j(x) })) : [{ json: j(json) }])

/** Read a dot path such as `body.items.0.id` from a value. */
export function getPath(obj: unknown, p: string): unknown {
  if (!p) return obj
  let cur: unknown = obj
  for (const key of p.split('.')) {
    if (cur == null) return undefined
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Write a dot path, creating objects along the way. */
export function setPath(obj: Record<string, unknown>, p: string, value: unknown): void {
  const keys = p.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  const last = keys[keys.length - 1]
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return
  cur[last] = value
}

export function exprCtx(ctx: NodeExecContext, item: Item): Record<string, unknown> {
  const index = Math.max(0, ctx.items.indexOf(item))
  return {
    $json: item.json,
    $binary: item.binary ?? {},
    $items: ctx.items,
    $input: { all: () => ctx.items, first: () => ctx.items[0], last: () => ctx.items[ctx.items.length - 1], item },
    $node: { name: ctx.node.name, type: ctx.node.type },
    $execution: {
      id: ctx.executionId ?? '',
      mode: ctx.mode,
      resumeUrl: ctx.executionId ? `${config.publicUrl}/webhook-waiting/${ctx.executionId}` : '',
    },
    $now: makeDateValue(),
    $index: index,
    // $('Node name') — output of an earlier node: .item (same index), .first(), .last(), .all(), .json
    $: (name: string) => {
      const outputs = ctx.runData?.[String(name)]
      if (!outputs) throw new Error(`No data from node "${name}" — check the name, and that it runs before this node`)
      const items = outputs.find((o) => o.length > 0) ?? []
      const paired = items[index] ?? items[0]
      return {
        all: () => items,
        first: () => items[0],
        last: () => items[items.length - 1],
        item: paired,
        json: paired?.json ?? {},
        isExecuted: true,
      }
    },
  }
}

export function evalCond(left: unknown, op: string, right: unknown): boolean {
  const l = left ?? ''
  const r = right ?? ''
  const ls = String(l)
  const rs = String(r)
  switch (op) {
    case 'equals':
      return ls === rs
    case 'notEquals':
      return ls !== rs
    case 'contains':
      return ls.toLowerCase().includes(rs.toLowerCase())
    case 'notContains':
      return !ls.toLowerCase().includes(rs.toLowerCase())
    case 'startsWith':
      return ls.startsWith(rs)
    case 'endsWith':
      return ls.endsWith(rs)
    case 'regex':
      try {
        return new RegExp(rs).test(ls)
      } catch {
        return false
      }
    case 'gt':
      return Number(l) > Number(r)
    case 'gte':
      return Number(l) >= Number(r)
    case 'lt':
      return Number(l) < Number(r)
    case 'lte':
      return Number(l) <= Number(r)
    case 'isEmpty':
      return ls.trim() === '' || l == null
    case 'isNotEmpty':
      return !(ls.trim() === '' || l == null)
    case 'isTrue':
      return l === true || ls === 'true'
    case 'isFalse':
      return l === false || ls === 'false'
    default:
      throw new Error(`Unknown operator "${op}"`)
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const parseJsonParam = <T>(v: unknown, fallback: T, label: string): T => {
  if (v == null || v === '') return fallback
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

// ---------------------------------------------------------------------------
// Wait planning (the engine pauses the run for long waits)
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

/**
 * Work out what a Wait node should do. Short waits run inline; anything longer
 * (or waiting for the resume webhook) is persisted and resumed later.
 */
export function planWait(ctx: NodeExecContext): { persist: false; ms: number } | { persist: true; until?: Date } {
  const p = interpolateParams<{ resume?: string; amount?: number; unit?: string; dateTime?: string; ms?: number }>(
    ctx.node.parameters as Record<string, unknown>,
    exprCtx(ctx, ctx.items[0] ?? { json: {} }),
  )
  const resume = p.resume ?? (p.amount != null ? 'afterTime' : 'legacyMs')
  if (resume === 'webhook') return { persist: true }
  let ms: number
  if (resume === 'atTime') {
    const until = new Date(String(p.dateTime ?? ''))
    if (Number.isNaN(until.getTime())) throw new Error(`Wait: "${p.dateTime}" is not a valid date/time`)
    ms = until.getTime() - Date.now()
  } else if (resume === 'legacyMs') {
    ms = Number(p.ms ?? 1000)
  } else {
    const unit = UNIT_MS[String(p.unit ?? 'seconds')]
    if (!unit) throw new Error(`Wait: unknown unit "${p.unit}"`)
    ms = Number(p.amount ?? 1) * unit
  }
  if (!Number.isFinite(ms)) throw new Error('Wait: the wait time is not a number')
  ms = Math.max(0, ms)
  if (ms <= 5000) return { persist: false, ms }
  return { persist: true, until: new Date(Date.now() + ms) }
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
}

export function resolveProvider(provider: string | undefined, credType?: string): string {
  if (credType === 'anthropicApi') return 'anthropic'
  if (credType === 'geminiApi') return 'gemini'
  return provider || 'openai'
}

async function callLLM(
  provider: string,
  cred: { type: string; data: Record<string, string> },
  model: string,
  system: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  if (provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: cred.data.apiKey, timeout: 120_000 })
    // Server-side fallback: if the model declines for policy reasons, the API
    // retries the same request on a fallback model inside this one call.
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
    }
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    if (!text) throw new Error(`Claude returned no text (stop reason: ${response.stop_reason})`)
    return text
  }

  if (provider === 'gemini') {
    const base = 'https://generativelanguage.googleapis.com/v1beta'
    const res = await fetchWithTimeout(
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cred.data.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature },
        }),
      },
      60000,
    )
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as any
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('')
    if (!text) throw new Error('Gemini returned no text')
    return text
  }

  const baseUrl = (cred.data.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.data.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
        temperature,
      }),
    },
    60000,
  )
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as any
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('LLM returned no content')
  return text
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

async function applyHttpAuth(ctx: NodeExecContext, headers: Record<string, string>): Promise<void> {
  const credId = ctx.node.credentials?.httpHeaderAuth
  if (!credId) return
  const cred = await ctx.getCredential(credId)
  if (!cred) throw new Error('The authentication credential no longer exists.')
  if (cred.type === 'headerAuth') headers[cred.data.name] = cred.data.value
  else if (cred.type === 'bearerToken') headers.Authorization = `Bearer ${cred.data.token}`
  else if (cred.type === 'basicAuth') {
    headers.Authorization = `Basic ${Buffer.from(`${cred.data.user ?? ''}:${cred.data.password ?? ''}`).toString('base64')}`
  }
}

interface HttpParams {
  method: string
  url: string
  queryParams: unknown
  headers: unknown
  bodyType?: string
  body: unknown
  timeout: number
  pagination?: string
  nextUrlPath?: string
  pageParam?: string
  resultsPath?: string
  maxPages?: number
  runOnce?: boolean
}

async function httpRequestForItem(ctx: NodeExecContext, p: HttpParams): Promise<Item[]> {
  if (!/^https?:\/\//i.test(String(p.url))) throw new Error(`Invalid URL: "${p.url}"`)
  const method = String(p.method || 'GET').toUpperCase()
  const headers: Record<string, string> = { ...parseJsonParam<Record<string, string>>(p.headers, {}, 'Headers') }
  await applyHttpAuth(ctx, headers)
  const query = parseJsonParam<Record<string, unknown>>(p.queryParams, {}, 'Query parameters')

  let body: string | undefined
  if (!['GET', 'HEAD'].includes(method) && p.body !== undefined && p.body !== '') {
    const bodyType = p.bodyType ?? 'raw'
    if (bodyType === 'json') {
      body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body)
      headers['Content-Type'] ??= 'application/json'
    } else if (bodyType === 'form') {
      const fields = parseJsonParam<Record<string, unknown>>(p.body, {}, 'Form body')
      body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? '')])).toString()
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    } else {
      body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body)
    }
  }

  const pagination = p.pagination ?? 'off'
  const maxPages = pagination === 'off' ? 1 : Math.min(100, Math.max(1, Number(p.maxPages ?? 10)))
  const pageParam = p.pageParam || 'page'
  let url = String(p.url)
  let page = Number(query[pageParam] ?? 1)
  const results: Item[] = []

  for (let i = 0; i < maxPages; i++) {
    const u = new URL(url)
    for (const [k, v] of Object.entries(query)) if (!(i > 0 && pagination === 'nextUrl')) u.searchParams.set(k, String(v))
    if (pagination === 'pageNumber') u.searchParams.set(pageParam, String(page))
    const res = await fetchWithTimeout(u.toString(), { method, headers, body }, Math.min(120000, Number(p.timeout) || 30000))
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
    results.push({ json: { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: parsed, ...(pagination !== 'off' ? { page: i + 1 } : {}) } })

    if (pagination === 'nextUrl') {
      const next = getPath(parsed, p.nextUrlPath || 'next')
      if (!next || typeof next !== 'string') break
      url = new URL(next, url).toString()
    } else if (pagination === 'pageNumber') {
      const list = getPath(parsed, p.resultsPath ?? '')
      if (!Array.isArray(list) || list.length === 0) break
      page++
    }
  }
  if (pagination !== 'off') ctx.logs.push(`[http] fetched ${results.length} page(s)`)
  return results
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

const perItemParams = <T>(ctx: NodeExecContext, item: Item): T =>
  interpolateParams<T>(ctx.node.parameters as Record<string, unknown>, exprCtx(ctx, item))

const compareValues = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b))
}

const handlers: Record<string, NodeHandler> = {
  // ---- Triggers ------------------------------------------------------------

  webhook: async (ctx) => {
    const payload = (ctx.trigger ?? {}) as Record<string, unknown>
    return [out({
      headers: payload.headers ?? {},
      query: payload.query ?? {},
      body: payload.body ?? null,
      method: payload.method ?? 'GET',
    })]
  },

  schedule: async (ctx) => {
    const payload = (ctx.trigger ?? {}) as Record<string, unknown>
    return [out({ timestamp: new Date().toISOString(), cron: ctx.node.parameters.cron, fired: payload })]
  },

  manualTrigger: async (ctx) => [out(ctx.trigger ?? { triggeredAt: new Date().toISOString() })],

  // ---- Core logic -----------------------------------------------------------

  if: async (ctx) => {
    const trueItems: Item[] = []
    const falseItems: Item[] = []
    for (const item of ctx.items) {
      const c = perItemParams<{ left: string; operator: string; right: string }>(ctx, item)
      ;(evalCond(c.left, c.operator, c.right) ? trueItems : falseItems).push(item)
    }
    return [trueItems, falseItems]
  },

  switch: async (ctx) => {
    const rules = (ctx.node.parameters.rules as Array<Record<string, string>>) ?? []
    const outputs: Item[][] = Array.from({ length: rules.length + 1 }, () => [])
    for (const item of ctx.items) {
      let matched = false
      for (let i = 0; i < rules.length; i++) {
        const rc = interpolateParams<{ left: string; operator: string; right: string }>(rules[i], exprCtx(ctx, item))
        if (evalCond(rc.left, rc.operator, rc.right)) {
          outputs[i].push(item)
          matched = true
          break
        }
      }
      if (!matched) outputs[rules.length].push(item) // fallback output
    }
    return outputs
  },

  merge: async (ctx) => {
    const mode = (ctx.node.parameters.mode as string) ?? 'append'
    const a = ctx.inputs[0] ?? []
    const b = ctx.inputs[1] ?? []
    if (mode === 'combine') {
      const len = Math.max(a.length, b.length)
      const items: Item[] = []
      for (let i = 0; i < len; i++) {
        items.push({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } })
      }
      return [items]
    }
    return [[...a, ...b]]
  },

  // Loop Over Items is run by the engine itself (it needs to re-run the loop body).
  loopOverItems: async (ctx) => [ctx.items, ctx.items],

  // Waits longer than a few seconds are paused/resumed by the engine; this handles the short ones.
  wait: async (ctx) => {
    const plan = planWait(ctx)
    if (!plan.persist) await new Promise((r) => setTimeout(r, plan.ms))
    return [ctx.items]
  },

  code: async (ctx) => {
    const src = String(ctx.node.parameters.jsCode ?? '')
    const mode = (ctx.node.parameters.mode as string) ?? 'runOnceForAllItems'
    const logs = ctx.logs
    const sandboxConsole = {
      log: (...args: unknown[]) => logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
      error: (...args: unknown[]) => logs.push('[error] ' + args.map(String).join(' ')),
      warn: (...args: unknown[]) => logs.push('[warn] ' + args.map(String).join(' ')),
    }

    const runScript = (code: string, sandbox: Record<string, unknown>): unknown => {
      const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
      const script = new vm.Script(`(function(){ ${code} })()`, { filename: 'CodeNode' })
      return script.runInContext(context, { timeout: 5000 })
    }

    const baseGlobals: Record<string, unknown> = {
      Math, JSON, Date, Number, String, Boolean, Array, Object, parseInt, parseFloat, isNaN,
      console: sandboxConsole,
      $: (name: string) => structuredClone((ctx.runData?.[String(name)] ?? []).find((o) => o.length > 0) ?? []),
    }

    try {
      if (mode === 'runOnceForEachItem') {
        const results: Item[] = []
        for (const item of ctx.items) {
          const value = runScript(src, { ...baseGlobals, $json: structuredClone(item.json), $binary: item.binary })
          results.push({ json: j(value) })
        }
        return [results]
      }
      const value = runScript(src, {
        ...baseGlobals,
        $input: { all: () => structuredClone(ctx.items), first: () => ctx.items[0], last: () => ctx.items[ctx.items.length - 1] },
        items: structuredClone(ctx.items),
      })
      if (Array.isArray(value)) {
        return [value.map((v) => (v && typeof v === 'object' && 'json' in (v as object) ? (v as Item) : { json: j(v) }))]
      }
      return [out(value)]
    } catch (err) {
      ;(err as Error).message = `Code node: ${(err as Error).message}${logs.length ? '\nconsole:\n' + logs.join('\n') : ''}`
      throw err
    }
  },

  // ---- Data transformation --------------------------------------------------

  noOp: async (ctx) => [ctx.items],

  set: async (ctx) => {
    const keepOnlySet = Boolean(ctx.node.parameters.keepOnlySet)
    return [ctx.items.map((item) => {
      const fields = parseJsonParam<Record<string, unknown>>(
        interpolateParams<Record<string, unknown>>({ f: ctx.node.parameters.fields ?? {} }, exprCtx(ctx, item)).f,
        {},
        'Fields',
      )
      const json: Record<string, unknown> = keepOnlySet ? {} : structuredClone(item.json)
      for (const [k, v] of Object.entries(fields)) setPath(json, k, v)
      return { ...item, json }
    })]
  },

  filter: async (ctx) => {
    const kept: Item[] = []
    for (const item of ctx.items) {
      const c = perItemParams<{ left: string; operator: string; right: string }>(ctx, item)
      if (evalCond(c.left, c.operator, c.right)) kept.push(item)
    }
    ctx.logs.push(`[filter] kept ${kept.length} of ${ctx.items.length} item(s)`)
    return [kept]
  },

  sort: async (ctx) => {
    const field = String(ctx.node.parameters.field ?? '')
    const dir = ctx.node.parameters.order === 'desc' ? -1 : 1
    return [[...ctx.items].sort((a, b) => dir * compareValues(getPath(a.json, field), getPath(b.json, field)))]
  },

  limit: async (ctx) => {
    const max = Math.max(0, Number(ctx.node.parameters.maxItems ?? 1))
    return [ctx.node.parameters.keep === 'last' ? ctx.items.slice(Math.max(0, ctx.items.length - max)) : ctx.items.slice(0, max)]
  },

  removeDuplicates: async (ctx) => {
    const field = String(ctx.node.parameters.field ?? '')
    const seen = new Set<string>()
    const kept = ctx.items.filter((item) => {
      const key = JSON.stringify(field ? getPath(item.json, field) : item.json)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    ctx.logs.push(`[dedupe] removed ${ctx.items.length - kept.length} duplicate(s)`)
    return [kept]
  },

  splitOut: async (ctx) => {
    const field = String(ctx.node.parameters.field ?? '')
    if (!field) throw new Error('Set "Field to split out" to the path of an array, e.g. body.items')
    const includeOthers = ctx.node.parameters.include === 'allOtherFields'
    const name = field.split('.').pop()!
    const result: Item[] = []
    for (const item of ctx.items) {
      const value = getPath(item.json, field)
      if (value == null) continue
      const list = Array.isArray(value) ? value : [value]
      for (const el of list) {
        const base = el && typeof el === 'object' && !Array.isArray(el) ? (el as Record<string, unknown>) : { [name]: el }
        result.push({ json: includeOthers ? { ...item.json, ...base } : { ...base } })
      }
    }
    return [result]
  },

  aggregate: async (ctx) => {
    if (ctx.node.parameters.mode === 'field') {
      const field = String(ctx.node.parameters.field ?? '')
      if (!field) throw new Error('Set the field to aggregate, or switch mode to "allItems"')
      const outputField = String(ctx.node.parameters.outputField || field.split('.').pop())
      const values = ctx.items.map((i) => getPath(i.json, field)).filter((v) => v !== undefined)
      return [[{ json: { [outputField]: values } }]]
    }
    const outputField = String(ctx.node.parameters.outputField || 'items')
    return [[{ json: { [outputField]: ctx.items.map((i) => i.json) } }]]
  },

  respondToWebhook: async (ctx) => {
    const p = perItemParams<{ statusCode: number; respondWith: string; body: unknown; headers: unknown }>(ctx, ctx.items[0] ?? { json: {} })
    const respondWith = p.respondWith ?? 'firstItem'
    let body: unknown
    if (respondWith === 'allItems') body = ctx.items.map((i) => i.json)
    else if (respondWith === 'firstItem') body = ctx.items[0]?.json ?? {}
    else if (respondWith === 'json') body = parseJsonParam<unknown>(p.body, {}, 'Response body')
    else if (respondWith === 'noData') body = ''
    else body = String(p.body ?? '')
    const response: WebhookResponse = {
      statusCode: Number(p.statusCode) || 200,
      headers: parseJsonParam<Record<string, string>>(p.headers, {}, 'Response headers'),
      body,
    }
    if (ctx.respond) ctx.respond(response)
    else ctx.logs.push('[respond] no webhook caller is waiting (not started by a webhook in "Respond to Webhook node" mode)')
    return [ctx.items]
  },

  // ---- AI & agents -----------------------------------------------------------

  aiAgent: async (ctx) => runLLMNode(ctx),
  llmChain: async (ctx) => runLLMNode(ctx),
  openai: async (ctx) => runLLMNode(ctx),

  vectorStore: async () => {
    throw new Error('Vector Store is coming soon and is not available in this build.')
  },
  memory: async () => {
    throw new Error('Memory is coming soon and is not available in this build.')
  },
  tool: async () => {
    throw new Error('Tool Calling is coming soon and is not available in this build.')
  },

  // ---- App integrations --------------------------------------------------------

  httpRequest: async (ctx) => {
    const once = Boolean(ctx.node.parameters.runOnce)
    const items = once ? [ctx.items[0] ?? { json: {} }] : ctx.items.slice(0, 500)
    if (!once && ctx.items.length > 500) ctx.logs.push(`[http] only the first 500 of ${ctx.items.length} items were requested`)
    const results: Item[] = []
    for (const item of items) results.push(...(await httpRequestForItem(ctx, perItemParams<HttpParams>(ctx, item))))
    return [results]
  },

  postgres: async (ctx) => {
    const credId = ctx.node.credentials?.postgres
    if (!credId) throw new Error('Select a PostgreSQL credential in the node settings.')
    const cred = await ctx.getCredential(credId)
    if (!cred) throw new Error('Credential not found.')
    const pg = await import('pg')
    const p = interpolateParams<{ query: string; values: string }>(
      ctx.node.parameters as Record<string, unknown>,
      exprCtx(ctx, ctx.items[0] ?? { json: {} }),
    )
    const values = parseJsonParam<unknown[]>(p.values, [], 'Values')
    const client = new pg.Client({
      host: cred.data.host ?? 'localhost',
      port: Number(cred.data.port ?? 5432),
      database: cred.data.database,
      user: cred.data.user,
      password: cred.data.password,
      ssl: cred.data.ssl === 'true' ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
    })
    try {
      await client.connect()
      const result = await client.query(p.query, values)
      return [out(result.rows)]
    } finally {
      await client.end().catch(() => {})
    }
  },

  redis: async (ctx) => {
    const credId = ctx.node.credentials?.redis
    if (!credId) throw new Error('Select a Redis credential in the node settings.')
    const cred = await ctx.getCredential(credId)
    if (!cred?.data.url) throw new Error('The Redis credential needs a URL, e.g. redis://localhost:6379')
    const mod = (await import('ioredis')) as any
    const Redis = mod.Redis ?? mod.default
    const client = new Redis(cred.data.url, { lazyConnect: true, connectTimeout: 10000, maxRetriesPerRequest: 1 })
    try {
      await client.connect()
      const results: Item[] = []
      for (const item of ctx.items.slice(0, 500)) {
        const p = perItemParams<{ operation: string; key: string; value: unknown; ttl: number }>(ctx, item)
        const key = String(p.key ?? '')
        if (!key) throw new Error('Redis: the key is empty')
        let value: unknown
        switch (p.operation ?? 'get') {
          case 'get': {
            const raw = await client.get(key)
            try { value = raw == null ? null : JSON.parse(raw) } catch { value = raw }
            break
          }
          case 'set': {
            const v = typeof p.value === 'string' ? p.value : JSON.stringify(p.value ?? null)
            value = Number(p.ttl) > 0 ? await client.set(key, v, 'EX', Number(p.ttl)) : await client.set(key, v)
            break
          }
          case 'delete':
            value = await client.del(key)
            break
          case 'incr':
            value = await client.incr(key)
            break
          default:
            throw new Error(`Redis: unknown operation "${p.operation}"`)
        }
        results.push({ json: { ...item.json, redis: { operation: p.operation ?? 'get', key, value } } })
      }
      return [results]
    } finally {
      client.disconnect()
    }
  },

  slack: async (ctx) => {
    const credId = ctx.node.credentials?.slackWebhook
    const p = interpolateParams<{ text: string; channel?: string; webhookUrl?: string }>(
      ctx.node.parameters as Record<string, unknown>,
      exprCtx(ctx, ctx.items[0] ?? { json: {} }),
    )
    let webhookUrl = p.webhookUrl as unknown as string
    if (credId) {
      const cred = await ctx.getCredential(credId)
      if (cred?.type === 'slackWebhook') webhookUrl = cred.data.webhookUrl
    }
    if (!webhookUrl) throw new Error('Slack webhook URL is required (parameter or credential).')
    const res = await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p.text, ...(p.channel ? { channel: p.channel } : {}) }),
    })
    if (!res.ok) throw new Error(`Slack error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return [out({ delivered: true, text: p.text })]
  },

  gmail: async () => {
    throw new Error('Gmail is coming soon — use the "Send Email" node with an SMTP credential instead.')
  },

  emailSend: async (ctx) => {
    const p = interpolateParams<{
      to: string
      from?: string
      subject: string
      body: string
      bodyType?: string
      dryRun?: boolean
    }>(ctx.node.parameters as Record<string, unknown>, exprCtx(ctx, ctx.items[0] ?? { json: {} }))

    const to = String(p.to ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (to.length === 0) throw new Error('The "To" field is empty — provide at least one address.')
    const bad = to.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))
    if (bad) throw new Error(`Invalid recipient address: "${bad}"`)

    const subject = String(p.subject ?? '(no subject)')
    const body = String(p.body ?? '')
    const isHtml = (p.bodyType ?? 'html') !== 'text'
    const from = String(p.from ?? '') || 'FlowOps <flowops@localhost>'

    const credId = ctx.node.credentials?.smtp
    const cred = credId ? await ctx.getCredential(credId) : null

    // No SMTP credential (or a dry run was requested): write a real .eml file to the outbox.
    if (!cred || cred.type !== 'smtp' || p.dryRun) {
      const dir = path.resolve(process.env.OUTBOX_DIR ?? 'data/outbox')
      await mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'email'
      const file = path.join(dir, `${stamp}-${slug}.eml`)
      // RFC 2047 encoding for non-ASCII headers, and strip CR/LF to prevent header injection.
      const header = (v: string) =>
        /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
      const headers = [
        `From: ${from.replace(/[\r\n]+/g, ' ')}`,
        `To: ${to.join(', ')}`,
        `Subject: ${header(subject.replace(/[\r\n]+/g, ' '))}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${stamp}.${Math.random().toString(36).slice(2, 10)}@flowops.local>`,
        'MIME-Version: 1.0',
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      ].join('\r\n')
      await writeFile(file, `${headers}\r\n\r\n${body}\r\n`, 'utf8')
      ctx.logs.push(`[email] no SMTP credential — wrote ${path.basename(file)} to the outbox instead of sending`)
      return [out({ sent: false, transport: 'outbox', to, subject, file: path.relative(process.cwd(), file).split(path.sep).join('/'), body })]
    }

    const nodemailer = await import('nodemailer')
    const secure = (cred.data.secure ?? 'false') === 'true'
    const transport = nodemailer.default.createTransport({
      host: cred.data.host,
      port: Number(cred.data.port ?? (secure ? 465 : 587)),
      secure,
      auth: cred.data.user ? { user: cred.data.user, pass: cred.data.password } : undefined,
    })
    try {
      const info = await transport.sendMail({
        from,
        to: to.join(', '),
        subject,
        ...(isHtml ? { html: body } : { text: body }),
      })
      ctx.logs.push(`[email] sent to ${to.join(', ')} via ${cred.type} (${info.messageId})`)
      return [out({ sent: true, transport: 'smtp', messageId: info.messageId, accepted: info.accepted, to, subject })]
    } finally {
      transport.close()
    }
  },
}

async function runLLMNode(ctx: NodeExecContext): Promise<Item[][]> {
  const p = interpolateParams<{
    provider: string
    model: string
    system: string
    prompt: string
    temperature: number
  }>(ctx.node.parameters as Record<string, unknown>, exprCtx(ctx, ctx.items[0] ?? { json: {} }))

  const credSlot = ctx.node.credentials?.llmApi ?? ctx.node.credentials?.openaiApi ?? ctx.node.credentials?.geminiApi
  if (!credSlot) {
    // Zero-config mode: no API key attached, so draft deterministically from the item data.
    if (p.provider === 'local') {
      return [ctx.items.slice(0, 20).map((item) => ({
        json: { text: localDraft(item.json), provider: 'local', model: 'template-v1' },
      }))]
    }
    throw new Error('Attach an AI credential to this node, or set Provider to "local" for an offline template draft.')
  }
  const cred = await ctx.getCredential(credSlot)
  if (!cred) throw new Error('Credential not found — it may have been deleted.')
  const provider = resolveProvider(ctx.node.type === 'openai' ? 'openai' : p.provider, cred.type)
  let model = String(p.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai)
  if (provider === 'anthropic' && !model.startsWith('claude')) {
    ctx.logs.push(`[llm] "${model}" is not a Claude model — using ${DEFAULT_MODELS.anthropic}`)
    model = DEFAULT_MODELS.anthropic
  }

  // Runs once per item (capped for safety), n8n-style.
  const items = ctx.items.slice(0, 20)
  const results: Item[] = []
  for (const item of items) {
    const perItem = perItemParams<{ prompt: string; system: string }>(ctx, item)
    const text = await callLLM(provider, cred, model, perItem.system ?? '', perItem.prompt, Number(p.temperature ?? 0.7))
    results.push({ json: { text, model, provider } })
  }
  return [results]
}

/**
 * Offline draft used when no LLM credential is attached (provider = local).
 * Renders a deterministic brief from structured item data instead of calling a model.
 */
function localDraft(json: Record<string, unknown>): string {
  const str = (v: unknown) => (v == null ? '' : String(v))
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.text ?? ''))).filter(Boolean) : []
  const date = str(json.dateLabel ?? json.date ?? new Date().toDateString())
  const highlights = list(json.highlights)
  const focus = list(json.focus)
  const metrics = (json.metrics ?? {}) as Record<string, unknown>

  const lines: string[] = ['Good morning,', '', `Here is your brief for ${date}.`]
  if (highlights.length) {
    lines.push('', '## Today at a glance')
    highlights.forEach((h, i) => lines.push(`${i + 1}. ${h}`))
  }
  if (focus.length) {
    lines.push('', '## Focus for today')
    focus.forEach((f) => lines.push(`- ${f}`))
  }
  const metricEntries = Object.entries(metrics)
  if (metricEntries.length) {
    lines.push('', '## Numbers')
    metricEntries.forEach(([k, v]) => lines.push(`- ${k}: ${str(v)}`))
  }
  lines.push('', 'Have a productive day,', 'FlowOps Assistant')
  return lines.join('\n')
}

export function getNodeHandler(type: string): NodeHandler {
  return handlers[type] ?? (async () => {
    throw new Error(`Unknown node type "${type}"`)
  })
}

// Kept for callers that only need the plain interpolation helper.
export { interpolate }
