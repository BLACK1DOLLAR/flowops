import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Braces, Table, FileJson } from 'lucide-react'
import type { Item } from '../types'

function JsonTree({ value, name, depth = 0, defaultOpen = true }: { value: unknown; name?: string; depth?: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen && depth < 2)

  if (value === null) return <Row name={name} type="null" preview="null" depth={depth} />
  if (typeof value !== 'object') {
    const type = typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'str'
    return <Row name={name} type={type} preview={typeof value === 'string' ? `"${value}"` : String(value)} depth={depth} />
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 py-[1px] text-left hover:bg-surface-2"
        style={{ paddingLeft: depth * 12 }}
      >
        {open ? <ChevronDown size={11} className="text-ink-faint" /> : <ChevronRight size={11} className="text-ink-faint" />}
        {name !== undefined && <span className="text-ink-dim">{name}:</span>}
        <span className="text-ink-faint">
          {Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div>
          {entries.map(([k, v]) => (
            <JsonTree key={k} name={k} value={v} depth={depth + 1} defaultOpen={defaultOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ name, type, preview, depth }: { name?: string; type: string; preview: string; depth: number }) {
  const color = type === 'num' ? 'text-[#7cb7ff]' : type === 'bool' ? 'text-[#c792ea]' : type === 'null' ? 'text-ink-faint' : 'text-ok'
  return (
    <div className="py-[1px] hover:bg-surface-2" style={{ paddingLeft: depth * 12 + 14 }}>
      {name !== undefined && <span className="text-ink-dim">{name}: </span>}
      <span className={`${color} break-words font-mono`}>{preview}</span>
    </div>
  )
}

function TableView({ items }: { items: Item[] }) {
  const rows = items.map((i) => i.json)
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))]
  return (
    <div className="overflow-auto p-3">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold text-ink-dim">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className="max-w-[220px] truncate border border-line px-2 py-1 font-mono text-ink-dim">
                  {typeof (r as Record<string, unknown>)?.[c] === 'object'
                    ? JSON.stringify((r as Record<string, unknown>)?.[c])
                    : String((r as Record<string, unknown>)?.[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function JsonView({ items, compact = false }: { items: Item[]; compact?: boolean }) {
  const [mode, setMode] = useState<'tree' | 'table' | 'raw'>('tree')

  if (items.length === 0) {
    return <div className="p-3 text-[11.5px] text-ink-faint">No items.</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button onClick={() => setMode('tree')} className={`viewtab ${mode === 'tree' ? 'active' : ''}`}><Braces size={11} /> Tree</button>
        <button onClick={() => setMode('table')} className={`viewtab ${mode === 'table' ? 'active' : ''}`}><Table size={11} /> Table</button>
        <button onClick={() => setMode('raw')} className={`viewtab ${mode === 'raw' ? 'active' : ''}`}><FileJson size={11} /> JSON</button>
        <span className="ml-auto text-[10px] text-ink-faint">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${compact ? '' : 'p-2'}`}>
        {mode === 'tree' && (
          <div className="font-mono text-[11.5px] leading-relaxed">
            {items.map((item, i) => (
              <Fragment key={i}>
                {items.length > 1 && <div className="px-2 pt-1 text-[9.5px] font-sans font-bold uppercase tracking-wide text-ink-faint">Item {i}</div>}
                <JsonTree value={item.json} defaultOpen={items.length <= 3} />
              </Fragment>
            ))}
          </div>
        )}
        {mode === 'table' && <TableView items={items} />}
        {mode === 'raw' && (
          <pre className="p-2 font-mono text-[11px] leading-relaxed text-ink-dim">
            {JSON.stringify(items.map((i) => i.json), null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
