import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { GROUPS, NODE_TYPES } from '../registry'
import { useStore } from '../store'

const DRAG_TYPE = 'application/flowops-node'

export function NodeDrawer() {
  const open = useStore((s) => s.drawerOpen)
  const setOpen = useStore((s) => s.setDrawerOpen)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = Object.values(NODE_TYPES)
    if (!q) return all
    return all.filter(
      (n) => n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q) || n.type.includes(q),
    )
  }, [query])

  if (!open) return null

  return (
    <aside className="slide-in absolute bottom-4 left-4 top-16 z-20 flex w-[290px] flex-col rounded-xl border border-line bg-surface shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Search size={14} className="text-ink-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation() }}
          placeholder="Search nodes…"
          className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink-faint"
        />
        <button onClick={() => setOpen(false)} className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Close node drawer">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {GROUPS.map((group) => {
          const nodes = filtered.filter((n) => n.group === group)
          if (nodes.length === 0) return null
          return (
            <div key={group} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">{group}</div>
              {nodes.map((def) => {
                const Icon = def.icon
                return (
                  <div
                    key={def.type}
                    draggable={!def.beta}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, def.type)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDoubleClick={() => {
                      if (!def.beta) {
                        useStore.getState().addNode(def.type) // placed + wired after the selected node
                      }
                    }}
                    title={def.beta ? 'Beta — not implemented in this build yet' : 'Drag onto the canvas'}
                    className={`group mb-1 flex cursor-grab items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 hover:border-line hover:bg-surface-2 ${
                      def.beta ? 'opacity-50' : ''
                    }`}
                  >
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md border border-line bg-surface-2 text-ink-dim group-hover:text-accent">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[12px] font-medium">
                        {def.name}
                        {def.beta && <span className="rounded bg-surface-3 px-1 text-[9px] font-bold text-ink-faint">BETA</span>}
                      </div>
                      <div className="truncate text-[10.5px] text-ink-faint">{def.description}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="border-t border-line px-3 py-2 text-[10.5px] text-ink-faint">
        Double-click to add after the selected node (auto-connected), or drag onto the canvas.
      </div>
    </aside>
  )
}

export { DRAG_TYPE }
