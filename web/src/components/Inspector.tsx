import { useMemo, useState } from 'react'
import { X, Play, Trash2, KeyRound } from 'lucide-react'
import { NODE_TYPES, CREDENTIAL_TYPE_LABELS, type NodeParam } from '../registry'
import { useStore } from '../store'
import { JsonView } from './JsonView'
import { CredentialModal } from './CredentialModal'

export function Inspector() {
  const open = useStore((s) => s.inspectorOpen)
  const nodeId = useStore((s) => s.selectedNodeId)
  const node = useStore((s) => s.workflow.nodes.find((n) => n.id === s.selectedNodeId))
  const nodeRuns = useStore((s) => s.nodeRuns)
  const connections = useStore((s) => s.workflow.connections)
  const closeInspector = useStore((s) => s.closeInspector)
  const updateParameter = useStore((s) => s.updateParameter)
  const updateNode = useStore((s) => s.updateNode)
  const updateCredentialRef = useStore((s) => s.updateCredentialRef)
  const deleteNode = useStore((s) => s.deleteNode)
  const testNode = useStore((s) => s.testNode)
  const credentialsOpen = useStore((s) => s.credentialsOpen)

  const upstreamIds = useMemo(
    () => connections.filter((c) => c.target === nodeId).map((c) => c.source),
    [connections, nodeId],
  )

  if (!open || !node) return null
  const def = NODE_TYPES[node.type]
  const run = nodeRuns[node.id]
  const inputItems = run?.input ?? []
  const output = run?.output?.[0] ?? []

  // Keep Backspace/Delete inside text fields from reaching React Flow's
  // global key handlers (which delete the selected node).
  const guardKeys = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    const editable =
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
    if (editable && (e.key === 'Backspace' || e.key === 'Delete')) e.stopPropagation()
  }

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
          />
          {run?.status === 'success' && <span className="badge bg-ok/15 text-ok">{run.durationMs} ms</span>}
          {run?.status === 'error' && <span className="badge bg-err/15 text-err">Error</span>}
          <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={!node.disabled}
              onChange={(e) => updateNode(node.id, { disabled: !e.target.checked })}
            />
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
              {def?.params.map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={node.parameters[param.name]}
                  onChange={(v) => updateParameter(node.id, param.name, v)}
                />
              ))}

              {/* Credentials */}
              {def?.credentials?.map((slot) => (
                <CredentialSelect
                  key={slot.key}
                  slotKey={slot.key}
                  label={slot.label}
                  value={node.credentials?.[slot.key] ?? ''}
                  onChange={(id) => updateCredentialRef(node.id, slot.key, id)}
                />
              ))}
            </div>

            <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-3">
              <button
                onClick={() => testNode(node.id)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-strong"
              >
                <Play size={11} fill="currentColor" /> Test Step
              </button>
              {run?.status === 'running' && <span className="text-[11px] text-accent">Running…</span>}
              {run?.error && <span className="min-w-0 flex-1 truncate text-[11px] text-err">{run.error}</span>}
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
            <PaneHeader title="Output Data" sub={run?.status === 'success' ? 'last test result' : 'run "Test Step" to see output'} />
            {run?.logs && run.logs.length > 0 && (
              <pre className="max-h-28 overflow-auto border-b border-line bg-canvas px-3 py-2 font-mono text-[10.5px] text-ink-faint">
                {run.logs.join('\n')}
              </pre>
            )}
            <JsonView items={output} />
          </section>
        </div>
      </div>
      {credentialsOpen && <CredentialModal />}
    </div>
  )
}

function PaneHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-line px-4 py-2.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">{title}</div>
      {sub && <div className="text-[10.5px] text-ink-faint">{sub}</div>}
    </div>
  )
}

const EXPR_VARS = ['$json.', '$items', '$binary', '$now', "$now.format('dddd, MMMM D')", '$execution', '$node.name', '$input.all()']

function ParamField({ param, value, onChange }: { param: NodeParam; value: unknown; onChange: (v: unknown) => void }) {
  const [focusExpr, setFocusExpr] = useState(false)
  const id = `param-${param.name}`

  const inputClass =
    'w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent placeholder:text-ink-faint/60'

  return (
    <div className="relative">
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-[11.5px] font-semibold text-ink-dim">{param.label}</label>
        {param.expressionHint && (
          <button
            type="button"
            onClick={() => onChange(typeof value === 'string' && value ? `${value}` : '{{ $json }}')}
            className="text-[10px] font-bold text-accent/80 hover:text-accent"
            title="Wrap as expression"
          >
            {'{ }'}
          </button>
        )}
      </div>

      {param.type === 'select' && (
        <select id={id} className={inputClass} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {param.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}

      {(param.type === 'text') && (
        <input
          id={id}
          className={`${inputClass} ${String(value ?? '').includes('{{') ? 'font-mono text-[12px] text-accent-strong' : ''}`}
          value={String(value ?? '')}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocusExpr(true)}
          onBlur={() => setTimeout(() => setFocusExpr(false), 150)}
        />
      )}

      {(param.type === 'textarea' || param.type === 'code') && (
        <textarea
          id={id}
          rows={param.type === 'code' ? 7 : 3}
          className={`${inputClass} resize-y font-mono text-[12px] leading-relaxed`}
          value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {param.type === 'number' && (
        <input id={id} type="number" step="any" className={inputClass} value={Number(value ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))} />
      )}

      {param.type === 'boolean' && (
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {param.label}
        </label>
      )}

      {param.type === 'json' && (
        <textarea
          id={id}
          rows={4}
          className={`${inputClass} resize-y font-mono text-[12px]`}
          value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try { onChange(JSON.parse(e.target.value)) } catch { onChange(e.target.value) }
          }}
        />
      )}

      {param.hint && <p className="mt-1 text-[10.5px] leading-snug text-ink-faint">{param.hint}</p>}

      {param.expressionHint && focusExpr && (
        <div className="absolute right-0 top-6 z-10 flex flex-col gap-0.5 rounded-md border border-line bg-surface-2 p-1 shadow-xl">
          {EXPR_VARS.map((v) => (
            <button
              key={v}
              type="button"
              className="rounded px-2 py-0.5 text-left font-mono text-[10.5px] text-ink-dim hover:bg-surface-3 hover:text-accent"
              onMouseDown={() => onChange(`{{ ${v} }}`)}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CredentialSelect({ slotKey, label, value, onChange }: { slotKey: string; label: string; value: string; onChange: (id: string) => void }) {
  const credentials = useStore((s) => s.credentials)
  const setCredentialsOpen = useStore((s) => s.setCredentialsOpen)
  const matching = credentials.filter((c) => c.type !== 'unknown')
  void slotKey

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
        </select>
        <button
          type="button"
          onClick={() => setCredentialsOpen(true)}
          className="rounded-md border border-line px-2 text-[11px] text-ink-dim hover:border-accent hover:text-accent"
        >
          + New
        </button>
      </div>
    </div>
  )
}
