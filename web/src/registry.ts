import type { LucideIcon } from 'lucide-react'
import type { WorkflowNode } from './types'
import {
  Webhook, Clock, Play, GitFork, Shuffle, Merge, Repeat, Timer, Code2,
  Bot, Sparkles, Database, Brain, Wrench, Globe, Server, Container, MessageSquare, Mail, Send, Zap,
  PenLine, Filter, ArrowUpDown, ListEnd, CopyMinus, Split, Layers, Reply, CircleDashed,
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
  /** Only show this field when another parameter has one of these values. */
  showIf?: { param: string; values: unknown[] }
}

export interface CredentialSlot {
  key: string // slot in node.credentials
  type: string // credential type, or a family such as 'any-llm' / 'httpAuth'
  label: string
}

export type NodeGroup = 'Triggers' | 'Core Logic' | 'Data' | 'AI & Agents' | 'App Integrations'

export interface NodeTypeDef {
  type: string
  name: string
  group: NodeGroup
  icon: LucideIcon
  description: string
  inputs: number
  outputs: number | 'dynamic-if' | 'dynamic-switch'
  outputLabels?: string[]
  params: NodeParam[]
  credentials?: CredentialSlot[]
  /** Shown in the palette but not runnable yet. */
  comingSoon?: boolean
  hasTriggerPayload?: boolean
}

const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']

const CONDITION_PARAMS: NodeParam[] = [
  { name: 'left', label: 'Value (left)', type: 'text', placeholder: '{{ $json.body.status }}', expressionHint: true, defaultValue: '' },
  { name: 'operator', label: 'Operator', type: 'select', defaultValue: 'equals', options: OPERATORS },
  { name: 'right', label: 'Compare to (right)', type: 'text', placeholder: 'active', expressionHint: true, defaultValue: '' },
]

const PROVIDER_PARAM: NodeParam = {
  name: 'provider', label: 'Provider', type: 'select', defaultValue: 'openai',
  options: ['openai', 'anthropic', 'gemini', 'local'],
  hint: 'local = offline template draft, no API key needed. The others need a matching credential.',
}

const LLM_PARAMS: NodeParam[] = [
  PROVIDER_PARAM,
  {
    name: 'model', label: 'Model', type: 'text', defaultValue: '',
    placeholder: 'blank = provider default (claude-opus-5-5 / gpt-4o-mini / gemini-2.5-flash)',
  },
  { name: 'system', label: 'System prompt', type: 'textarea', defaultValue: 'You are a helpful assistant.' },
  { name: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'Summarize: {{ $json.body.text }}', expressionHint: true },
  {
    name: 'temperature', label: 'Temperature', type: 'number', defaultValue: 0.7,
    hint: 'Used by OpenAI-compatible and Gemini models. Current Claude models choose their own sampling.',
  },
]

const LLM_CREDENTIAL: CredentialSlot = { key: 'llmApi', type: 'any-llm', label: 'AI credential (Anthropic, OpenAI-compatible or Gemini)' }

export const NODE_TYPES: Record<string, NodeTypeDef> = {
  webhook: {
    type: 'webhook', name: 'Webhook', group: 'Triggers', icon: Webhook,
    description: 'Starts the workflow when an HTTP request hits the generated URL.',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [
      { name: 'path', label: 'Path', type: 'text', placeholder: 'order-created', defaultValue: '' },
      { name: 'method', label: 'Method', type: 'select', defaultValue: 'POST', options: ['GET', 'POST', 'PUT', 'DELETE', 'ALL'] },
      {
        name: 'responseMode', label: 'Respond', type: 'select', defaultValue: 'immediately',
        options: ['immediately', 'lastNode', 'responseNode'],
        hint: 'immediately = queue the run and answer at once. lastNode = wait and return the last node\'s output. responseNode = answer from a "Respond to Webhook" node.',
      },
    ],
    credentials: [{ key: 'webhookHmac', type: 'hmacSecret', label: 'Signing secret (optional — requests must send a matching X-Signature header)' }],
  },
  schedule: {
    type: 'schedule', name: 'Schedule (Cron)', group: 'Triggers', icon: Clock,
    description: 'Runs the workflow on a cron schedule.',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [
      { name: 'cron', label: 'Cron expression', type: 'text', placeholder: '*/15 * * * *', defaultValue: '*/15 * * * *', hint: 'Standard 5-field cron. Example: 0 8 * * 1-5 = 8:00 on weekdays.' },
      { name: 'timezone', label: 'Timezone', type: 'text', placeholder: 'Europe/London', defaultValue: '', hint: 'IANA name. Blank = the server\'s timezone.' },
    ],
  },
  manualTrigger: {
    type: 'manualTrigger', name: 'Manual Trigger', group: 'Triggers', icon: Play,
    description: 'Runs when you click "Test Workflow".',
    inputs: 0, outputs: 1, hasTriggerPayload: true,
    params: [{ name: 'note', label: 'Note', type: 'text', defaultValue: '' }],
  },

  if: {
    type: 'if', name: 'IF', group: 'Core Logic', icon: GitFork,
    description: 'Routes items to the true or false branch based on a condition.',
    inputs: 1, outputs: 'dynamic-if', outputLabels: ['true', 'false'],
    params: CONDITION_PARAMS,
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
    params: [{ name: 'mode', label: 'Mode', type: 'select', defaultValue: 'append', options: ['append', 'combine'] }],
  },
  loopOverItems: {
    type: 'loopOverItems', name: 'Loop Over Items', group: 'Core Logic', icon: Repeat,
    description: 'Runs the nodes on the "loop" output once per batch; wire the last one back into this node.',
    inputs: 1, outputs: 2, outputLabels: ['done', 'loop'],
    params: [
      {
        name: 'batchSize', label: 'Batch size', type: 'number', defaultValue: 1,
        hint: 'Connect "loop" to the steps to repeat and wire the last step back into this node. "done" fires once with every result.',
      },
    ],
  },
  wait: {
    type: 'wait', name: 'Wait', group: 'Core Logic', icon: Timer,
    description: 'Pauses for a time, until a date, or until its resume URL is called.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'resume', label: 'Resume', type: 'select', defaultValue: 'afterTime', options: ['afterTime', 'atTime', 'webhook'], hint: 'webhook = waits until something calls {{ $execution.resumeUrl }} (send that link from an earlier node).' },
      { name: 'amount', label: 'Amount', type: 'number', defaultValue: 1, showIf: { param: 'resume', values: ['afterTime'] } },
      { name: 'unit', label: 'Unit', type: 'select', defaultValue: 'minutes', options: ['seconds', 'minutes', 'hours', 'days'], showIf: { param: 'resume', values: ['afterTime'] } },
      { name: 'dateTime', label: 'Resume at', type: 'text', placeholder: '2026-12-01T09:00:00Z', expressionHint: true, defaultValue: '', showIf: { param: 'resume', values: ['atTime'] } },
    ],
  },
  code: {
    type: 'code', name: 'Code (JavaScript)', group: 'Core Logic', icon: Code2,
    description: 'Runs custom JavaScript in a sandboxed VM.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'mode', label: 'Run mode', type: 'select', defaultValue: 'runOnceForAllItems', options: ['runOnceForAllItems', 'runOnceForEachItem'] },
      {
        name: 'jsCode', label: 'JavaScript', type: 'code',
        defaultValue: "// Available: $input.all(), items, $('Node name'), Math, JSON\nconst items = $input.all();\nreturn items.map(item => ({ json: { ...item.json, processed: true } }));",
        hint: 'Return an array of { json } items (or a single value).',
      },
    ],
  },
  noOp: {
    type: 'noOp', name: 'No Operation', group: 'Core Logic', icon: CircleDashed,
    description: 'Passes items through unchanged. Handy as a placeholder or branch end.',
    inputs: 1, outputs: 1, params: [],
  },

  set: {
    type: 'set', name: 'Edit Fields (Set)', group: 'Data', icon: PenLine,
    description: 'Add or overwrite fields on each item.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'fields', label: 'Fields (JSON)', type: 'json', defaultValue: { status: 'new' }, hint: 'Object of field → value. Dot paths (user.name) create nested fields; values can use {{ }} expressions.' },
      { name: 'keepOnlySet', label: 'Keep only these fields', type: 'boolean', defaultValue: false },
    ],
  },
  filter: {
    type: 'filter', name: 'Filter', group: 'Data', icon: Filter,
    description: 'Keep only the items that match a condition.',
    inputs: 1, outputs: 1, params: CONDITION_PARAMS,
  },
  sort: {
    type: 'sort', name: 'Sort', group: 'Data', icon: ArrowUpDown,
    description: 'Sort items by a field.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'field', label: 'Field', type: 'text', placeholder: 'createdAt', defaultValue: '' },
      { name: 'order', label: 'Order', type: 'select', defaultValue: 'asc', options: ['asc', 'desc'] },
    ],
  },
  limit: {
    type: 'limit', name: 'Limit', group: 'Data', icon: ListEnd,
    description: 'Keep only the first (or last) N items.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'maxItems', label: 'Max items', type: 'number', defaultValue: 10 },
      { name: 'keep', label: 'Keep', type: 'select', defaultValue: 'first', options: ['first', 'last'] },
    ],
  },
  removeDuplicates: {
    type: 'removeDuplicates', name: 'Remove Duplicates', group: 'Data', icon: CopyMinus,
    description: 'Drop items that repeat a field value (or the whole item).',
    inputs: 1, outputs: 1,
    params: [{ name: 'field', label: 'Compare field', type: 'text', placeholder: 'email (blank = whole item)', defaultValue: '' }],
  },
  splitOut: {
    type: 'splitOut', name: 'Split Out', group: 'Data', icon: Split,
    description: 'Turn an array field into separate items.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'field', label: 'Field to split out', type: 'text', placeholder: 'body.items', defaultValue: '' },
      { name: 'include', label: 'Include', type: 'select', defaultValue: 'none', options: ['none', 'allOtherFields'] },
    ],
  },
  aggregate: {
    type: 'aggregate', name: 'Aggregate', group: 'Data', icon: Layers,
    description: 'Combine many items into one.',
    inputs: 1, outputs: 1,
    params: [
      { name: 'mode', label: 'Mode', type: 'select', defaultValue: 'allItems', options: ['allItems', 'field'] },
      { name: 'field', label: 'Field to collect', type: 'text', placeholder: 'id', defaultValue: '', showIf: { param: 'mode', values: ['field'] } },
      { name: 'outputField', label: 'Output field', type: 'text', placeholder: 'items', defaultValue: '' },
    ],
  },
  respondToWebhook: {
    type: 'respondToWebhook', name: 'Respond to Webhook', group: 'Data', icon: Reply,
    description: 'Send the HTTP response for a webhook set to "responseNode".',
    inputs: 1, outputs: 1,
    params: [
      { name: 'statusCode', label: 'Status code', type: 'number', defaultValue: 200 },
      { name: 'respondWith', label: 'Respond with', type: 'select', defaultValue: 'firstItem', options: ['firstItem', 'allItems', 'json', 'text', 'noData'] },
      { name: 'body', label: 'Body', type: 'textarea', placeholder: '{ "ok": true, "id": "{{ $json.id }}" }', expressionHint: true, defaultValue: '', showIf: { param: 'respondWith', values: ['json', 'text'] } },
      { name: 'headers', label: 'Headers (JSON)', type: 'json', defaultValue: {} },
    ],
  },

  aiAgent: {
    type: 'aiAgent', name: 'AI Agent', group: 'AI & Agents', icon: Bot,
    description: 'Calls an LLM with a system + user prompt (once per item).',
    inputs: 1, outputs: 1, params: LLM_PARAMS, credentials: [LLM_CREDENTIAL],
  },
  llmChain: {
    type: 'llmChain', name: 'LLM Chain', group: 'AI & Agents', icon: Sparkles,
    description: 'Simple single LLM completion chain.',
    inputs: 1, outputs: 1, params: LLM_PARAMS, credentials: [LLM_CREDENTIAL],
  },
  vectorStore: {
    type: 'vectorStore', name: 'Vector Store', group: 'AI & Agents', icon: Database,
    description: 'Store and retrieve embeddings.',
    inputs: 1, outputs: 1, comingSoon: true,
    params: [{ name: 'operation', label: 'Operation', type: 'select', options: ['insert', 'search'], defaultValue: 'search' }],
  },
  memory: {
    type: 'memory', name: 'Memory', group: 'AI & Agents', icon: Brain,
    description: 'Conversation memory buffer for agents.',
    inputs: 1, outputs: 1, comingSoon: true,
    params: [{ name: 'windowSize', label: 'Window size', type: 'number', defaultValue: 10 }],
  },
  tool: {
    type: 'tool', name: 'Tool Calling', group: 'AI & Agents', icon: Wrench,
    description: 'Give the agent callable tools.',
    inputs: 1, outputs: 1, comingSoon: true,
    params: [{ name: 'tools', label: 'Tools (JSON)', type: 'json', defaultValue: [] }],
  },

  httpRequest: {
    type: 'httpRequest', name: 'HTTP Request', group: 'App Integrations', icon: Globe,
    description: 'Call any REST API (once per item).',
    inputs: 1, outputs: 1,
    params: [
      { name: 'method', label: 'Method', type: 'select', defaultValue: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com/v1/users', expressionHint: true, defaultValue: '' },
      { name: 'queryParams', label: 'Query parameters (JSON)', type: 'json', defaultValue: {}, hint: 'e.g. { "status": "open", "limit": 50 }' },
      { name: 'headers', label: 'Headers (JSON)', type: 'json', defaultValue: {}, hint: 'e.g. { "Accept": "application/json" }' },
      { name: 'bodyType', label: 'Body type', type: 'select', defaultValue: 'json', options: ['json', 'form', 'raw'], showIf: { param: 'method', values: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      { name: 'body', label: 'Body', type: 'textarea', placeholder: '{ "email": "{{ $json.body.email }}" }', expressionHint: true, defaultValue: '', showIf: { param: 'method', values: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      { name: 'pagination', label: 'Pagination', type: 'select', defaultValue: 'off', options: ['off', 'nextUrl', 'pageNumber'], hint: 'nextUrl = follow a "next" link in the response. pageNumber = increase a page parameter until an empty page.' },
      { name: 'nextUrlPath', label: 'Next-page URL field', type: 'text', placeholder: 'next or links.next', defaultValue: 'next', showIf: { param: 'pagination', values: ['nextUrl'] } },
      { name: 'pageParam', label: 'Page parameter', type: 'text', defaultValue: 'page', showIf: { param: 'pagination', values: ['pageNumber'] } },
      { name: 'resultsPath', label: 'Results field (stop when empty)', type: 'text', placeholder: 'data', defaultValue: '', showIf: { param: 'pagination', values: ['pageNumber'] } },
      { name: 'maxPages', label: 'Max pages', type: 'number', defaultValue: 10, showIf: { param: 'pagination', values: ['nextUrl', 'pageNumber'] } },
      { name: 'runOnce', label: 'Run once (ignore extra items)', type: 'boolean', defaultValue: false },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', defaultValue: 30000 },
    ],
    credentials: [{ key: 'httpHeaderAuth', type: 'httpAuth', label: 'Authentication (optional — header, bearer or basic)' }],
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
    description: 'Get, set, delete or increment keys in Redis (once per item).',
    inputs: 1, outputs: 1,
    params: [
      { name: 'operation', label: 'Operation', type: 'select', defaultValue: 'get', options: ['get', 'set', 'delete', 'incr'] },
      { name: 'key', label: 'Key', type: 'text', placeholder: 'user:{{ $json.id }}', expressionHint: true, defaultValue: '' },
      { name: 'value', label: 'Value', type: 'textarea', expressionHint: true, defaultValue: '', showIf: { param: 'operation', values: ['set'] } },
      { name: 'ttl', label: 'Expire after (seconds, 0 = never)', type: 'number', defaultValue: 0, showIf: { param: 'operation', values: ['set'] } },
    ],
    credentials: [{ key: 'redis', type: 'redis', label: 'Redis connection' }],
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
    inputs: 1, outputs: 1, comingSoon: true,
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
    credentials: [{ key: 'llmApi', type: 'openaiApi', label: 'OpenAI-compatible credential' }],
  },
}

export const CREDENTIAL_FIELD_DEFS: Record<string, Array<{ name: string; label: string; secret?: boolean; placeholder?: string }>> = {
  anthropicApi: [{ name: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-…' }],
  openaiApi: [
    { name: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-…' },
    { name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
  ],
  geminiApi: [{ name: 'apiKey', label: 'API key', secret: true, placeholder: 'AIza…' }],
  headerAuth: [
    { name: 'name', label: 'Header name', placeholder: 'X-API-Key' },
    { name: 'value', label: 'Header value', secret: true },
  ],
  bearerToken: [{ name: 'token', label: 'Token', secret: true }],
  basicAuth: [
    { name: 'user', label: 'Username' },
    { name: 'password', label: 'Password', secret: true },
  ],
  hmacSecret: [{ name: 'secret', label: 'Signing secret', secret: true }],
  postgres: [
    { name: 'host', label: 'Host', placeholder: 'localhost' },
    { name: 'port', label: 'Port', placeholder: '5432' },
    { name: 'database', label: 'Database' },
    { name: 'user', label: 'User' },
    { name: 'password', label: 'Password', secret: true },
    { name: 'ssl', label: 'SSL (true/false)', placeholder: 'false' },
  ],
  redis: [{ name: 'url', label: 'Connection URL', secret: true, placeholder: 'redis://user:pass@localhost:6379' }],
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
  anthropicApi: 'Anthropic (Claude) API',
  openaiApi: 'OpenAI-compatible API',
  geminiApi: 'Google Gemini API',
  headerAuth: 'Header Auth',
  bearerToken: 'Bearer Token',
  basicAuth: 'Basic Auth',
  hmacSecret: 'Webhook Signing Secret',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  slackWebhook: 'Slack Webhook',
  smtp: 'SMTP',
}

const CREDENTIAL_FAMILIES: Record<string, string[]> = {
  'any-llm': ['anthropicApi', 'openaiApi', 'geminiApi'],
  httpAuth: ['headerAuth', 'bearerToken', 'basicAuth'],
}

/** Whether a credential of `credType` can fill a slot declared as `slotType`. */
export function credentialAccepts(slotType: string, credType: string): boolean {
  return (CREDENTIAL_FAMILIES[slotType] ?? [slotType]).includes(credType)
}

/** Credential types that can fill a slot (for the "new credential" picker). */
export function credentialTypesFor(slotType: string): string[] {
  return CREDENTIAL_FAMILIES[slotType] ?? [slotType]
}

export const GROUPS: NodeGroup[] = ['Triggers', 'Core Logic', 'Data', 'AI & Agents', 'App Integrations']

/** Regular outputs, plus the extra "error" output when the node routes errors there. */
export function outputCount(def: NodeTypeDef, node: Pick<WorkflowNode, 'parameters' | 'settings'>): number {
  let count: number
  if (def.outputs === 'dynamic-if') count = 2
  else if (def.outputs === 'dynamic-switch') count = Math.max(1, ((node.parameters.rules as unknown[] | undefined) ?? []).length + 1)
  else count = def.outputs
  return node.settings?.onError === 'errorOutput' ? count + 1 : count
}

export function outputLabels(def: NodeTypeDef, node: Pick<WorkflowNode, 'parameters' | 'settings'>): string[] {
  const n = outputCount(def, node)
  const labels = Array.from({ length: n }, (_, i) => def.outputLabels?.[i] ?? '')
  if (def.outputs === 'dynamic-switch') {
    const rules = ((node.parameters.rules as unknown[] | undefined) ?? []).length
    for (let i = 0; i < rules; i++) labels[i] = String(i + 1)
    labels[rules] = 'fallback'
  }
  if (node.settings?.onError === 'errorOutput') labels[n - 1] = 'error'
  return labels
}

export function defaultParameters(type: string): Record<string, unknown> {
  const def = NODE_TYPES[type]
  const params: Record<string, unknown> = {}
  for (const p of def?.params ?? []) params[p.name] = p.defaultValue ?? (p.type === 'boolean' ? false : '')
  return params
}

let counter = 0
export function newNodeId(): string {
  counter++
  return `node_${Date.now().toString(36)}_${counter}`
}

export function newNode(type: string) {
  const def = NODE_TYPES[type]
  const node: WorkflowNode = {
    id: newNodeId(),
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
  const first = def?.params.find((p) => p.type !== 'boolean' && p.type !== 'select' && !p.showIf)
  if (!first) return ''
  const v = parameters[first.name]
  if (v === undefined || v === null || String(v) === '') return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}
