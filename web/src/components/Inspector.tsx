import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Play, Trash2, KeyRound, Pin, PinOff } from 'lucide-react'
import { NODE_TYPES, CREDENTIAL_TYPE_LABELS, credentialAccepts, outputLabels, type NodeParam } from '../registry'
import { useStore } from '../store'
import type { Item, NodeSettings, WorkflowNode } from '../types'
import { JsonView } from './JsonView'
import { CredentialModal } from './CredentialModal'

export function Inspector() {
  const open = useStore((s) => s.inspectorOpen)
  const nodeId = useStore((s) => s.selectedNodeId)
  const node = useStore((s) => s.workflow.nodes.find((n) => n.id === s.selectedNodeId))
  const nodes = useStore((s) => s.workflow.nodes)
  const nodeRuns = useStore((s) => s.nodeRuns)
  const connections = useStore((s) => s.workflow.connections)
  const closeInspector = useStore((s) => s.closeInspector)
  const updateParameter = useStore((s) => s.updateParameter)
  const updateNode = useStore((s) => s.updateNode)
  const updateCredentialRef = useStore((s) => s.updateCredentialRef)
  const deleteNode = useStore((s) => s.deleteNode)
  const testNode = useStore((s) => s.testNode)
  const pinOutput = useStore((s) => s.pinOutput)
  const unpinOutput = useStore((s) => s.unpinOutput)
  const credentialsOpen = useStore((s) => s.credentialsOpen)
  const [outputIndex, setOutputIndex] = useState(0)

  const upstreamIds = useMemo(
    () => connections.filter((c) => c.target === nodeId).map((c) => c.source),
    [connections, nodeId],
  )

  // Every node that can feed this one (directly or further back) — candidates for $('Name').
  const ancestorNames = useMemo(() => {
    const seen = new Set<string>()
    const stack = [...upstreamIds]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const c of connections) if (c.target === id) stack.push(c.source)
    }
    return nodes.filter((n) => seen.has(n.id)).map((n) => n.name)
  }, [upstreamIds, connections, nodes])

  if (!open || !node) return null
  const def = NODE_TYPES[node.type]
  const run = nodeRuns[node.id]
  const inputItems = run?.input ?? []
  const labels = def ? outputLabels(def, node) : ['']
  const outputs = run?.output ?? []
  const shownIndex = Math.min(outputIndex, Math.max(0, labels.length - 1))
  const output = outputs[shownIndex] ?? []
  const fieldPaths = collectPaths(inputItems)
  const pinned = Boolean(node.pinData?.length)

  // Keep Backspace/Delete and editor shortcuts inside text fields away from the canvas.
  const guardKeys = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    const editable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
    if (editable) e.stopPropagation()
  }

  const visibleParams = (def?.params ?? []).filter(
    (p) => !p.showIf || p.showIf.values.includes(node.parameters[p.showIf.param] ?? defaultOf(def!.params, p.showIf.param)),
  )

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-2 md:p-6" onClick={(e) => e.target === e.currentTarget && closeInspector()} onKeyDown={guardKeys}>
      <div className="flex h-full max-h-[860px] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          {def && <def.icon size={16} className="text-accent" />}
          <input
            className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none"
            value={node.name}
            onChange={(e) => updateNode(node.id, { name: e.target.value })}
            aria-label="Node name"
            title="Other nodes refer to this one as $('name') — renaming breaks those references"
          />
          {run?.status === 'success' && <span className="badge bg-ok/15 text-ok">{run.durationMs} ms</span>}
          {run?.status === 'error' && <span className="badge bg-err/15 text-err">Error</span>}
          {run?.status === 'waiting' && <span className="badge bg-accent/15 text-accent">Waiting</span>}
          <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <input type="checkbox" checked={!node.disabled} onChange={(e) => updateNode(node.id, { disabled: !e.target.checked })} />
            Enabled
          </label>
          <button onClick={closeInspector} className="rounded p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Close inspector">
            <X size={16} />
          </button>
        </div>

        {/* 3 panes */}
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-line overflow-y-auto md:grid-cols-[1fr_1.35fr_1fr] md:divide-x md:divide-y-0 md:overflow-hidden">
          {/* LEFT: input data */}
          <section className="flex min-h-0 flex-col">
            <PaneHeader title="Input Data" sub={upstreamIds.length ? 'from previous node' : 'no upstream connection'} />
            <JsonView items={inputItems} />
          </section>

          {/* CENTER: parameters */}
          <section className="flex min-h-0 flex-col overflow-y-auto">
            <PaneHeader title="Parameters" sub={def?.name ?? node.type} />
            <div className="flex flex-col gap-3.5 px-4 py-3">
              {def?.comingSoon && (
                <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink-dim">
                  This node is coming soon — it shows up in the palette but cannot run yet.
                </p>
              )}
              {visibleParams.map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={node.parameters[param.name]}
                  onChange={(v) => updateParameter(node.id, param.name, v)}
                  fieldPaths={fieldPaths}
                  nodeNames={ancestorNames}
                />
              ))}

              {def?.credentials?.map((slot) => (
                <CredentialSelect
                  key={slot.key}
                  slotType={slot.type}
                  label={slot.label}
                  value={node.credentials?.[slot.key] ?? ''}
                  onChange={(id) => updateCredentialRef(node.id, slot.key, id)}
                />
              ))}

              {def && def.group !== 'Triggers' && <NodeSettingsPanel node={node} />}
            </div>

            <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-3">
              <button
                onClick={() => testNode(node.id)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-strong"
              >
                <Play size={11} fill="currentColor" /> Test Step
              </button>
              {run?.status === 'running' && <span className="text-[11px] text-accent">Running…</span>}
              {run?.error && <span className="min-w-0 flex-1 truncate text-[11px] text-err" title={run.error}>{run.error}</span>}
              <span className="flex-1" />
              <button
                onClick={() => { deleteNode(node.id); closeInspector() }}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-err hover:bg-err/10"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </section>

          {/* RIGHT: output data */}
          <section className="flex min-h-0 flex-col">
            <div className="flex items-start gap-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">Output Data</div>
                <div className="text-[10.5px] text-ink-faint">
                  {pinned ? 'pinned — manual runs return this instead of running the node' : run?.status === 'success' ? 'last test result' : 'run "Test Step" to see output'}
                </div>
              </div>
              {pinned ? (
                <button onClick={() => unpinOutput(node.id)} className="flex items-center gap-1 rounded-md border border-accent/50 px-2 py-1 text-[10.5px] font-semibold text-accent hover:bg-accent/10" title="Unpin output">
                  <PinOff size={11} /> Unpin
                </button>
              ) : (
                <button
                  onClick={() => pinOutput(node.id)}
                  disabled={!outputs[0]?.length}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] text-ink-dim hover:border-accent hover:text-accent disabled:opacity-40"
                  title="Pin this output so manual runs reuse it instead of calling the node again"
                >
                  <Pin size={11} /> Pin
                </button>
              )}
            </div>
            {labels.length > 1 && (
              <div className="flex gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label="Output">
                {labels.map((l, i) => (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={shownIndex === i}
                    onClick={() => setOutputIndex(i)}
                    className={`rounded px-2 py-0.5 text-[10.5px] font-semibold ${shownIndex === i ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'}`}
                  >
                    {l || `Output ${i + 1}`} <span className="font-normal opacity-70">{outputs[i]?.length ?? 0}</span>
                  </button>
                ))}
              </div>
            )}
            {run?.logs && run.logs.length > 0 && (
              <pre className="max-h-28 overflow-auto border-b border-line bg-canvas px-3 py-2 font-mono text-[10.5px] text-ink-faint">
                {run.logs.join('\n')}
              </pre>
            )}
            <JsonView items={pinned && !run?.output ? node.pinData! : output} />
          </section>
        </div>
      </div>
      {credentialsOpen && <CredentialModal />}
    </div>
  )
}

function defaultOf(params: NodeParam[], name: string): unknown {
  return params.find((p) => p.name === name)?.defaultValue
}

/** Dot paths of the fields in the first few input items, for autocomplete. */
function collectPaths(items: Item[]): string[] {
  const paths = new Set<string>()
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (depth > 3 || v === null || typeof v !== 'object' || Array.isArray(v)) return
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue
      const p = prefix ? `${prefix}.${k}` : k
      paths.add(p)
      walk(child, p, depth + 1)
    }
  }
  for (const item of items.slice(0, 5)) walk(item.json, '', 0)
  return [...paths].slice(0, 40)
}

function PaneHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-line px-4 py-2.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">{title}</div>
      {sub && <div className="text-[10.5px] text-ink-faint">{sub}</div>}
    </div>
  )
}

const BASE_VARS = ['$now', "$now.format('dddd, MMMM D')", '$execution.id', '$execution.resumeUrl', '$node.name', '$input.all()', '$index']

function ParamField({
  param, value, onChange, fieldPaths, nodeNames,
}: {
  param: NodeParam
  value: unknown
  onChange: (v: unknown) => void
  fieldPaths: string[]
  nodeNames: string[]
}) {
  const [showVars, setShowVars] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Close the suggestions when clicking anywhere outside this field.
  useEffect(() => {
    if (!showVars) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setShowVars(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showVars])

  const handleTextChange = (next: string) => {
    onChange(next)
    // Typing "{{" opens the suggestions.
    if (param.expressionHint && next.endsWith('{{') && !text.endsWith('{{')) setShowVars(true)
  }
  const id = `param-${param.name}`
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2)

  const inputClass =
    'w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent placeholder:text-ink-faint/60'

  const suggestions = useMemo(() => {
    const all = [
      ...fieldPaths.map((p) => `$json.${p}`),
      ...nodeNames.map((n) => `$('${n.replace(/'/g, "\\'")}').item.json`),
      ...BASE_VARS,
    ]
    const q = filter.trim().toLowerCase()
    return (q ? all.filter((s) => s.toLowerCase().includes(q)) : all).slice(0, 14)
  }, [fieldPaths, nodeNames, filter])

  /** Insert `{{ expr }}` at the cursor instead of replacing the whole value. */
  const insert = (expr: string) => {
    setShowVars(false)
    const el = inputRef.current
    const snippet = `{{ ${expr} }}`
    if (!el) return onChange(text + snippet)
    let start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    if (text.slice(0, start).endsWith('{{')) start -= 2 // replace the "{{" that opened the list
    onChange(text.slice(0, start) + snippet + text.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }

  return (
    <div className="relative" ref={boxRef}>
      <div className="mb-1 flex items-center justify-between">
        {param.type !== 'boolean' && <label htmlFor={id} className="text-[11.5px] font-semibold text-ink-dim">{param.label}</label>}
        {param.expressionHint && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowVars((v) => !v)}
            aria-expanded={showVars}
            aria-label={`Insert an expression into ${param.label}`}
            className={`rounded px-1 text-[10px] font-bold ${showVars ? 'bg-accent/15 text-accent' : 'text-accent/70 hover:text-accent'}`}
            title="Insert a field or expression (or type {{ )"
          >
            {'{ }'}
          </button>
        )}
      </div>

      {param.type === 'select' && (
        <select id={id} className={inputClass} value={String(value ?? param.defaultValue ?? '')} onChange={(e) => onChange(e.target.value)}>
          {param.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}

      {param.type === 'text' && (
        <input
          id={id}
          ref={inputRef}
          className={`${inputClass} ${text.includes('{{') ? 'font-mono text-[12px] text-accent-strong' : ''}`}
          value={text}
          placeholder={param.placeholder}
          onChange={(e) => handleTextChange(e.target.value)}
        />
      )}

      {(param.type === 'textarea' || param.type === 'code') && (
        <textarea
          id={id}
          ref={inputRef}
          rows={param.type === 'code' ? 7 : 3}
          className={`${inputClass} resize-y font-mono text-[12px] leading-relaxed`}
          value={text}
          placeholder={param.placeholder}
          onChange={(e) => handleTextChange(e.target.value)}
        />
      )}

      {param.type === 'number' && (
        <input id={id} type="number" step="any" className={inputClass} value={Number(value ?? param.defaultValue ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))} />
      )}

      {param.type === 'boolean' && (
        <label className="flex items-center gap-2 text-[12px]">
          <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {param.label}
        </label>
      )}

      {param.type === 'json' && <JsonField id={id} className={inputClass} value={value} onChange={onChange} />}

      {param.hint && <p className="mt-1 text-[10.5px] leading-snug text-ink-faint">{param.hint}</p>}

      {param.expressionHint && showVars && (
        <div className="mt-1 w-full rounded-md border border-line bg-surface-2 p-1 shadow-lg" role="listbox" aria-label="Expression suggestions">
          <input
            className="mb-1 w-full rounded border border-line bg-canvas px-2 py-0.5 text-[10.5px] outline-none"
            placeholder="Filter fields…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setShowVars(false) }}
          />
          {suggestions.length === 0 && <p className="px-2 py-1 text-[10.5px] text-ink-faint">No matches. Run the workflow once to see input fields here.</p>}
          <div className="max-h-44 overflow-y-auto">
            {suggestions.map((v) => (
              <button
                key={v}
                type="button"
                className="block w-full truncate rounded px-2 py-0.5 text-left font-mono text-[10.5px] text-ink-dim hover:bg-surface-3 hover:text-accent"
                onMouseDown={(e) => { e.preventDefault(); insert(v) }}
                title={`Insert {{ ${v} }}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** JSON textarea that keeps the raw text while it's invalid and shows the parse error. */
function JsonField({ id, className, value, onChange }: { id: string; className: string; value: unknown; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = draft ?? (typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2))
  return (
    <>
      <textarea
        id={id}
        rows={4}
        className={`${className} resize-y font-mono text-[12px] ${error ? 'border-err' : ''}`}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value)
          try {
            onChange(JSON.parse(e.target.value))
            setError(null)
          } catch (err) {
            setError((err as Error).message)
          }
        }}
        onBlur={() => { if (!error) setDraft(null) }}
      />
      {error && <p className="mt-1 text-[10.5px] text-err">Invalid JSON — not saved yet: {error}</p>}
    </>
  )
}

function NodeSettingsPanel({ node }: { node: WorkflowNode }) {
  const update = useStore((s) => s.updateNodeSettings)
  const settings: NodeSettings = node.settings ?? {}
  const cls = 'rounded-md border border-line bg-canvas px-2 py-1 text-[12px] outline-none focus:border-accent'
  return (
    <details className="rounded-lg border border-line bg-surface-2/60 p-3" open={Boolean(settings.retryOnFail || (settings.onError && settings.onError !== 'stop'))}>
      <summary className="cursor-pointer text-[11.5px] font-semibold text-ink-dim">Settings — retries & errors</summary>
      <div className="mt-3 flex flex-col gap-2.5 text-[12px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(settings.retryOnFail)} onChange={(e) => update(node.id, { retryOnFail: e.target.checked })} />
          Retry on fail
        </label>
        {settings.retryOnFail && (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <label className="flex items-center gap-1.5">
              Tries
              <input type="number" min={1} max={10} className={`${cls} w-16`} value={settings.maxTries ?? 3}
                onChange={(e) => update(node.id, { maxTries: Number(e.target.value) })} />
            </label>
            <label className="flex items-center gap-1.5">
              Wait (ms)
              <input type="number" min={0} max={60000} step={500} className={`${cls} w-24`} value={settings.waitBetweenTries ?? 1000}
                onChange={(e) => update(node.id, { waitBetweenTries: Number(e.target.value) })} />
            </label>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-ink-dim">On error</span>
          <select className={cls} value={settings.onError ?? 'stop'} onChange={(e) => update(node.id, { onError: e.target.value as NodeSettings['onError'] })}>
            <option value="stop">Stop this branch (mark the run failed)</option>
            <option value="continue">Continue — pass items on with an "error" field</option>
            <option value="errorOutput">Send failed items to an extra "error" output</option>
          </select>
        </label>
      </div>
    </details>
  )
}

function CredentialSelect({ slotType, label, value, onChange }: { slotType: string; label: string; value: string; onChange: (id: string) => void }) {
  const credentials = useStore((s) => s.credentials)
  const setCredentialsOpen = useStore((s) => s.setCredentialsOpen)
  const matching = credentials.filter((c) => credentialAccepts(slotType, c.type))

  return (
    <div className="rounded-lg border border-line bg-surface-2/60 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-dim">
        <KeyRound size={11} /> {label}
      </div>
      <div className="flex gap-1.5">
        <select
          className="flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px] outline-none focus:border-accent"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— none —</option>
          {matching.map((c) => <option key={c.id} value={c.id}>{c.name} ({CREDENTIAL_TYPE_LABELS[c.type] ?? c.type})</option>)}
          {value && !matching.some((c) => c.id === value) && <option value={value}>(missing credential)</option>}
        </select>
        <button
          type="button"
          onClick={() => setCredentialsOpen(true, slotType)}
          className="rounded-md border border-line px-2 text-[11px] text-ink-dim hover:border-accent hover:text-accent"
        >
          + New
        </button>
      </div>
    </div>
  )
}
