import type { LucideIcon } from 'lucide-react'
import type { WorkflowNode } from './types'
import {
  Webhook, Clock, Play, GitFork, Shuffle, Merge, Repeat, Timer, Code2,
  Bot, Sparkles, Database, Brain, Wrench, Globe, Server, Container, MessageSquare, Mail, Send, Zap,
} from 'lucide-react'

export type ParamType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json' | 'code'

export interface NodeParam {
  name: string
  label: string
  type: ParamType
  options?: string[]
  placeholder?: string
  hint?: string
  defaultValue?: unknown
  expressionHint?: boolean
}

export interface CredentialSlot {
  key: string // slot in node.credentials
  type: string // credential type
  label: string
}

export interface NodeTypeDef {
  type: string
  name: string
  group: 'Triggers' | 'Core Logic' | 'AI & Agents' | 'App Integrations'
  icon: LucideIcon
  description: string
  inputs: number
  outputs: number | 'dynamic-if' | 'dynamic-switch'
  outputLabels?: string[]
  params: NodeParam[]
  credentials?: CredentialSlot[]
  beta?: boolean
  hasTriggerPayload?: boolean
}

const IF_PARAM: NodeParam[] = [
  { name: 'left', label: 'Value (left)', type: 'text', placeholder: '{{ $json.body.status }}', expressionHint: true, defaultValue: '' },
  {
    name: 'operator', label: 'Operator', type: 'select', defaultValue: 'equals',
    options: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'],
  },
  { name: 'right', label: 'Compare to (right)', type: 'text', placeholder: 'active', expressionHint: true, defaultValue: '' },
]

const PROVIDER_PARAM: NodeParam = {
  name: 'provider', label: 'Provider', type: 'select', defaultValue: 'openai',
  options: ['openai', 'gemini', 'local'],
  hint: 'local = offline template draft, no API key needed. openai/gemini require a credential.',
}

const LLM_PARAMS: NodeParam[] = [
  PROVIDER_PARAM,
  { name: 'model', label: 'Model', type: 'text', defaultValue: 'gpt-4o-mini', placeholder: 'gpt-4o-mini / gemini-2.5-flash' },
  { name: 'system', label: 'System prompt', type: 'textarea', defaultValue: 'You are a helpful assistant.' },
  { name: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'Summarize: {{ $json.body.text }}', expressionHint: true },
  { name: 'temperature', label: 'Temperature', type: 'number', defaultValue: 0.7 },
]

export const NODE_TYPES: Record<string, NodeTypeDef> = {
  webhook: {
    type: 'webhook', name: 'Webhook', group: 'Triggers', icon: Webhook,
    description: 'Starts the workflow when an HTTP request hits the generated URL.',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [
      { name: 'path', label: 'Path', type: 'text', placeholder: 'order-created', defaultValue: '' },
      { name: 'method', label: 'Method', type: 'select', defaultValue: 'POST', options: ['GET', 'POST', 'PUT', 'DELETE', 'ALL'] },
      { name: 'hmacSecret', label: 'HMAC secret (optional)', type: 'text', hint: 'If set, requests must send a matching X-Signature header (HMAC-SHA256 of the raw body).', defaultValue: '' },
    ],
  },
  schedule: {
    type: 'schedule', name: 'Schedule (Cron)', group: 'Triggers', icon: Clock,
    description: 'Runs the workflow on a cron schedule.',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [
      { name: 'cron', label: 'Cron expression', type: 'text', placeholder: '*/15 * * * *', defaultValue: '*/15 * * * *', hint: 'Standard 5-field cron. Example: every 15 minutes.' },
    ],
  },
  manualTrigger: {
    type: 'manualTrigger', name: 'Manual Trigger', group: 'Triggers', icon: Play,
    description: 'Runs when you click "Test Workflow".',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [
      { name: 'note', label: 'Note', type: 'text', defaultValue: '' },
    ],
  },

  if: {
    type: 'if', name: 'IF', group: 'Core Logic', icon: GitFork,
    description: 'Routes items to the true or false branch based on a condition.',
    inputs: 1, outputs: 'dynamic-if', outputLabels: ['true', 'false'],
    params: IF_PARAM,
  },
  switch: {
    type: 'switch', name: 'Switch', group: 'Core Logic', icon: Shuffle,
    description: 'Routes each item to the output of the first matching rule (plus a fallback output).',
    inputs: 1, outputs: 'dynamic-switch',
    params: [
      { name: 'rules', label: 'Rules', type: 'json', defaultValue: [{ left: '{{ $json.type }}', operator: 'equals', right: 'a' }], hint: 'Array of { left, operator, right } objects. Each rule becomes an output; unmatched items go to the fallback (last) output.' },
    ],
  },
  merge: {
    type: 'merge', name: 'Merge', group: 'Core Logic', icon: Merge,
    description: 'Combines two branches. Append concatenates; combine merges items by index.',
    inputs: 2, outputs: 1,
    params: [
      { name: 'mode', label: 'Mode', type: 'select', defaultValue: 'append', options: ['append', 'combine'] },
    ],
  },
  loopOverItems: {
    type: 'loopOverItems', name: 'Loop Over Items', group: 'Core Logic', icon: Repeat,
    description: 'Splits incoming items into batches.',
    inputs: 1, outputs: 1,
    params: [{ name: 'batchSize', label: 'Batch size', type: 'number', defaultValue: 1 }],
  },
  wait: {
    type: 'wait', name: 'Wait', group: 'Core Logic', icon: Timer,
    description: 'Pauses execution for the given number of milliseconds (max 60s).',
    inputs: 1, outputs: 1,
    params: [{ name: 'ms', label: 'Milliseconds', type: 'number', defaultValue: 1000 }],
  },
  code: {
    type: 'code', name: 'Code (JavaScript)', group: 'Core Logic', icon: Code2,
    description: 'Runs custom JavaScript in a sandboxed VM.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'mode', label: 'Run mode', type: 'select', defaultValue: 'runOnceForAllItems', options: ['runOnceForAllItems', 'runOnceForEachItem'] },
      {
        name: 'jsCode', label: 'JavaScript', type: 'code',
        defaultValue: "// Available: $input.all(), items, Math, JSON\nconst items = $input.all();\nreturn items.map(item => ({ json: { ...item.json, processed: true } }));",
        hint: 'Return an array of { json } items (or a single value).',
      },
    ],
  },

  aiAgent: {
    type: 'aiAgent', name: 'AI Agent', group: 'AI & Agents', icon: Bot,
    description: 'Calls an LLM with a system + user prompt (once per item).',
    inputs: 1, outputs: 1,
    params: LLM_PARAMS,
    credentials: [{ key: 'llmApi', type: 'any-llm', label: 'LLM credential (OpenAI-compatible or Gemini)' }],
  },
  llmChain: {
    type: 'llmChain', name: 'LLM Chain', group: 'AI & Agents', icon: Sparkles,
    description: 'Simple single LLM completion chain.',
    inputs: 1, outputs: 1,
    params: LLM_PARAMS,
    credentials: [{ key: 'llmApi', type: 'any-llm', label: 'LLM credential' }],
  },
  vectorStore: {
    type: 'vectorStore', name: 'Vector Store', group: 'AI & Agents', icon: Database,
    description: 'Store and retrieve embeddings.',
    inputs: 1, outputs: 1, beta: true,
    params: [{ name: 'operation', label: 'Operation', type: 'select', options: ['insert', 'search'], defaultValue: 'search' }],
  },
  memory: {
    type: 'memory', name: 'Memory', group: 'AI & Agents', icon: Brain,
    description: 'Conversation memory buffer for agents.',
    inputs: 1, outputs: 1, beta: true,
    params: [{ name: 'windowSize', label: 'Window size', type: 'number', defaultValue: 10 }],
  },
  tool: {
    type: 'tool', name: 'Tool Calling', group: 'AI & Agents', icon: Wrench,
    description: 'Give the agent callable tools.',
    inputs: 1, outputs: 1, beta: true,
    params: [{ name: 'tools', label: 'Tools (JSON)', type: 'json', defaultValue: [] }],
  },

  httpRequest: {
    type: 'httpRequest', name: 'HTTP Request', group: 'App Integrations', icon: Globe,
    description: 'Call any REST API.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'method', label: 'Method', type: 'select', defaultValue: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com/v1/users', expressionHint: true, defaultValue: '' },
      { name: 'headers', label: 'Headers (JSON)', type: 'json', defaultValue: {}, hint: 'e.g. { "Content-Type": "application/json" }' },
      { name: 'body', label: 'Body', type: 'textarea', placeholder: '{ "email": "{{ $json.body.email }}" }', expressionHint: true, defaultValue: '' },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', defaultValue: 30000 },
    ],
    credentials: [{ key: 'httpHeaderAuth', type: 'headerAuth', label: 'Header auth (optional)' }],
  },
  postgres: {
    type: 'postgres', name: 'PostgreSQL', group: 'App Integrations', icon: Server,
    description: 'Run a SQL query against a Postgres database.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'query', label: 'Query', type: 'code', placeholder: 'SELECT * FROM users WHERE id = $1', defaultValue: 'SELECT 1 AS ok;' },
      { name: 'values', label: 'Values (JSON array)', type: 'json', defaultValue: [] },
    ],
    credentials: [{ key: 'postgres', type: 'postgres', label: 'Postgres connection' }],
  },
  redis: {
    type: 'redis', name: 'Redis', group: 'App Integrations', icon: Container,
    description: 'Read/write keys in Redis.',
    inputs: 1, outputs: 1, beta: true,
    params: [{ name: 'key', label: 'Key', type: 'text', defaultValue: '' }],
  },
  slack: {
    type: 'slack', name: 'Slack', group: 'App Integrations', icon: MessageSquare,
    description: 'Post a message via an incoming webhook.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'text', label: 'Message', type: 'textarea', placeholder: 'New order: {{ $json.body.orderId }}', expressionHint: true, defaultValue: '' },
      { name: 'channel', label: 'Channel (optional)', type: 'text', defaultValue: '' },
    ],
    credentials: [{ key: 'slackWebhook', type: 'slackWebhook', label: 'Slack incoming webhook' }],
  },
  gmail: {
    type: 'gmail', name: 'Gmail', group: 'App Integrations', icon: Mail,
    description: 'Send or read emails (requires OAuth2).',
    inputs: 1, outputs: 1, beta: true,
    params: [{ name: 'to', label: 'To', type: 'text', defaultValue: '' }],
  },
  emailSend: {
    type: 'emailSend', name: 'Send Email', group: 'App Integrations', icon: Send,
    description: 'Send an email over SMTP. Without an SMTP credential it writes a real .eml file to the outbox.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'to', label: 'To', type: 'text', placeholder: 'you@example.com', expressionHint: true, defaultValue: '' },
      { name: 'subject', label: 'Subject', type: 'text', placeholder: 'Your morning brief', expressionHint: true, defaultValue: '' },
      { name: 'body', label: 'Body', type: 'textarea', placeholder: '{{ $json.body }}', expressionHint: true, defaultValue: '' },
      { name: 'bodyType', label: 'Body format', type: 'select', defaultValue: 'html', options: ['html', 'text'] },
      { name: 'from', label: 'From (optional)', type: 'text', placeholder: 'FlowOps <flowops@yourdomain.com>', defaultValue: '' },
      { name: 'dryRun', label: 'Always write to outbox (dry run)', type: 'boolean', defaultValue: false, hint: 'Keeps the file in data/outbox instead of delivering it, even when a credential is attached.' },
    ],
    credentials: [{ key: 'smtp', type: 'smtp', label: 'SMTP (optional — omit to use the outbox)' }],
  },
  openai: {
    type: 'openai', name: 'OpenAI', group: 'App Integrations', icon: Zap,
    description: 'Chat completion via an OpenAI-compatible API.',
    inputs: 1, outputs: 1,
    params: LLM_PARAMS.filter((p) => p.name !== 'provider'),
    credentials: [{ key: 'llmApi', type: 'any-llm', label: 'OpenAI-compatible credential' }],
  },
}

export const CREDENTIAL_FIELD_DEFS: Record<string, Array<{ name: string; label: string; secret?: boolean; placeholder?: string }>> = {
  openaiApi: [
    { name: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-…' },
    { name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
  ],
  geminiApi: [{ name: 'apiKey', label: 'API key', secret: true, placeholder: 'AIza…' }],
  headerAuth: [
    { name: 'name', label: 'Header name', placeholder: 'Authorization' },
    { name: 'value', label: 'Header value', secret: true },
  ],
  postgres: [
    { name: 'host', label: 'Host', placeholder: 'localhost' },
    { name: 'port', label: 'Port', placeholder: '5432' },
    { name: 'database', label: 'Database' },
    { name: 'user', label: 'User' },
    { name: 'password', label: 'Password', secret: true },
    { name: 'ssl', label: 'SSL (true/false)', placeholder: 'false' },
  ],
  slackWebhook: [{ name: 'webhookUrl', label: 'Incoming webhook URL', secret: true, placeholder: 'https://hooks.slack.com/…' }],
  smtp: [
    { name: 'host', label: 'Host', placeholder: 'smtp.gmail.com' },
    { name: 'port', label: 'Port', placeholder: '587' },
    { name: 'user', label: 'Username', placeholder: 'you@example.com' },
    { name: 'password', label: 'Password / app password', secret: true },
    { name: 'secure', label: 'Implicit TLS (true/false)', placeholder: 'false' },
  ],
}

export const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  openaiApi: 'OpenAI-compatible API',
  geminiApi: 'Google Gemini API',
  headerAuth: 'Header Auth',
  postgres: 'PostgreSQL',
  slackWebhook: 'Slack Webhook',
  smtp: 'SMTP',
}

export const GROUPS: NodeTypeDef['group'][] = ['Triggers', 'Core Logic', 'AI & Agents', 'App Integrations']

export function outputCount(def: NodeTypeDef, node: WorkflowNode): number {
  if (def.outputs === 'dynamic-if') return 2
  if (def.outputs === 'dynamic-switch') {
    const rules = (node.parameters.rules as unknown[] | undefined) ?? []
    return Math.max(1, rules.length + 1)
  }
  return def.outputs
}

export interface WorkflowNodeLike {
  parameters: Record<string, unknown>
}

export function defaultParameters(type: string): Record<string, unknown> {
  const def = NODE_TYPES[type]
  const params: Record<string, unknown> = {}
  for (const p of def?.params ?? []) params[p.name] = p.defaultValue ?? (p.type === 'boolean' ? false : '')
  return params
}

let counter = 0
export function newNode(type: string) {
  counter++
  const def = NODE_TYPES[type]
  const node: WorkflowNode = {
    id: `node_${Date.now().toString(36)}_${counter}`,
    name: def?.name ?? type,
    type,
    position: { x: 0, y: 0 },
    parameters: defaultParameters(type),
    credentials: {},
  }
  return node
}

export function paramSummary(type: string, parameters: Record<string, unknown>): string {
  const def = NODE_TYPES[type]
  const first = def?.params.find((p) => p.type !== 'boolean' && p.type !== 'select')
  if (!first) return ''
  const v = parameters[first.name]
  if (v === undefined || v === null || String(v) === '') return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}
