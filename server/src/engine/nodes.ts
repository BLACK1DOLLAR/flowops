import vm from 'node:vm'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Store } from '../store/types.js'
import type { Item, WorkflowNode } from '../store/types.js'
import { interpolate, interpolateParams, makeDateValue } from '../expression.js'

export interface NodeExecContext {
  node: WorkflowNode
  items: Item[]
  inputs: Item[][] // items delivered per input index
  trigger?: unknown // trigger payload (webhook body, cron fire, manual input)
  mode: 'manual' | 'test' | 'production' | 'retry'
  logs: string[] // handler can push console output for the execution log
  getCredential: (id: string) => Promise<{ type: string; data: Record<string, string> } | null>
  store: Store
}

export type NodeHandler = (ctx: NodeExecContext) => Promise<Item[][]>

const j = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v }

const out = (json: unknown): Item[] => (Array.isArray(json) ? json.map((x) => ({ json: j(x) })) : [{ json: j(json) }])

function exprCtx(ctx: NodeExecContext, item: Item): Record<string, unknown> {
  return {
    $json: item.json,
    $binary: item.binary ?? {},
    $items: ctx.items,
    $input: { all: () => ctx.items, first: () => ctx.items[0], last: () => ctx.items[ctx.items.length - 1] },
    $node: { name: ctx.node.name, type: ctx.node.type },
    $execution: { mode: ctx.mode },
    $now: makeDateValue(),
    $index: ctx.items.indexOf(item),
  }
}

function evalCond(left: unknown, op: string, right: unknown): boolean {
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

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

async function callLLM(
  provider: string,
  cred: { type: string; data: Record<string, string> },
  model: string,
  system: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  if (provider === 'gemini' || cred.type === 'geminiApi') {
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

  const baseUrl = (cred.data.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
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
// Node handlers
// ---------------------------------------------------------------------------

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
    const p = interpolateParams<{
      left: string
      operator: string
      right: string
      caseSensitive?: boolean
    }>(ctx.node.parameters as Record<string, unknown>, exprCtx(ctx, ctx.items[0] ?? { json: {} }))
    const trueItems: Item[] = []
    const falseItems: Item[] = []
    for (const item of ctx.items) {
      const c = interpolateParams<{ left: string; operator: string; right: string }>(
        ctx.node.parameters as Record<string, unknown>,
        exprCtx(ctx, item),
      )
      const ok = evalCond(c.left, c.operator, c.right)
      ;(ok ? trueItems : falseItems).push(item)
    }
    void p
    return [trueItems, falseItems]
  },

  switch: async (ctx) => {
    const rules = (ctx.node.parameters.rules as Array<Record<string, string>>) ?? []
    const outputs: Item[][] = Array.from({ length: rules.length + 1 }, () => [])
    for (const item of ctx.items) {
      const c = interpolateParams<{ left: string; operator: string; right: string }>(
        ctx.node.parameters as Record<string, unknown>,
        exprCtx(ctx, item),
      )
      let matched = false
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]
        const rc = interpolateParams<{ left: string; operator: string; right: string }>(rule, exprCtx(ctx, item))
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

  loopOverItems: async (ctx) => {
    const batchSize = Math.max(1, Number(ctx.node.parameters.batchSize ?? 1))
    const batches: Item[] = []
    for (let i = 0; i < ctx.items.length; i += batchSize) {
      batches.push({ json: { batchIndex: batches.length, total: Math.ceil(ctx.items.length / batchSize), items: ctx.items.slice(i, i + batchSize) } })
    }
    return [batches]
  },

  wait: async (ctx) => {
    const ms = Math.min(60000, Number(interpolate(String(ctx.node.parameters.ms ?? '1000'), exprCtx(ctx, ctx.items[0] ?? { json: {} }))) || 1000)
    await new Promise((r) => setTimeout(r, ms))
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
      Math,
      JSON,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      parseInt,
      parseFloat,
      isNaN,
      console: sandboxConsole,
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

  // ---- AI & agents -----------------------------------------------------------

  aiAgent: async (ctx) => runLLMNode(ctx),
  llmChain: async (ctx) => runLLMNode(ctx),
  openai: async (ctx) => runLLMNode(ctx),

  vectorStore: async () => {
    throw new Error('Vector Store is not implemented in this build yet.')
  },
  memory: async () => {
    throw new Error('Memory is not implemented in this build yet.')
  },
  tool: async () => {
    throw new Error('Tool Calling is not implemented in this build yet.')
  },

  // ---- App integrations --------------------------------------------------------

  httpRequest: async (ctx) => {
    const p = interpolateParams<{
      method: string
      url: string
      headers: string | Record<string, string>
      body: string
      timeout: number
    }>(ctx.node.parameters as Record<string, unknown>, exprCtx(ctx, ctx.items[0] ?? { json: {} }))
    if (!/^https?:\/\//i.test(p.url)) throw new Error(`Invalid URL: "${p.url}"`)

    const headers: Record<string, string> = {}
    if (p.headers) {
      const parsed =
        typeof p.headers === 'string' ? (JSON.parse(p.headers) as Record<string, string>) : (p.headers as Record<string, string>)
      Object.assign(headers, parsed)
    }

    // Optional header-auth credential
    const credId = ctx.node.credentials?.httpHeaderAuth
    if (credId) {
      const cred = await ctx.getCredential(credId)
      if (cred?.type === 'headerAuth') headers[cred.data.name] = cred.data.value
    }

    const res = await fetchWithTimeout(p.url, {
      method: p.method ?? 'GET',
      headers: { ...(Object.keys(headers).length ? headers : undefined) },
      body: ['GET', 'HEAD'].includes(p.method) || !p.body ? undefined : p.body,
    }, Math.min(60000, p.timeout || 30000))

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    const output = { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: parsed }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
    return [out(output)]
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
    const values = p.values ? (JSON.parse(p.values) as unknown[]) : []
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

  redis: async () => {
    throw new Error('Redis node requires the server to run with a Redis connection and ioredis installed.')
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
    throw new Error('Gmail requires OAuth2 setup — use the "Send Email" node with an SMTP credential instead.')
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to[0]) && !to.every((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) {
      throw new Error(`Invalid recipient address: "${to[0]}"`)
    }

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
  const provider = p.provider ?? 'openai'
  if (!credSlot) {
    // Zero-config mode: no API key attached, so draft deterministically from the item data.
    if (provider === 'local') {
      return [ctx.items.slice(0, 20).map((item) => ({
        json: { text: localDraft(item.json), provider: 'local', model: 'template-v1' },
      }))]
    }
    throw new Error('Attach an AI credential to this node, or set Provider to "local" for an offline template draft.')
  }
  const cred = await ctx.getCredential(credSlot)
  if (!cred) throw new Error('Credential not found — it may have been deleted.')

  // Runs once per item (capped for safety), n8n-style.
  const items = ctx.items.slice(0, 20)
  const results: Item[] = []
  for (const item of items) {
    const perItem = interpolateParams<{ prompt: string; system: string }>(
      ctx.node.parameters as Record<string, unknown>,
      exprCtx(ctx, item),
    )
    const text = await callLLM(
      p.provider ?? 'openai',
      cred,
      p.model || 'gpt-4o-mini',
      perItem.system ?? '',
      perItem.prompt,
      Number(p.temperature ?? 0.7),
    )
    results.push({ json: { text, model: p.model, provider: p.provider ?? 'openai' } })
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

export const NODE_OUTPUT_LABELS: Record<string, string[]> = {
  if: ['true', 'false'],
  switch: [], // dynamic
}
