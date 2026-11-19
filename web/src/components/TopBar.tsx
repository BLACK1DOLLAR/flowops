import { useState } from 'react'
import { Save, Menu, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'

export function TopBar() {
  const name = useStore((s) => s.workflow.name)
  const setName = useStore((s) => s.setName)
  const active = useStore((s) => s.workflow.active)
  const dirty = useStore((s) => s.dirty)
  const saving = useStore((s) => s.saving)
  const save = useStore((s) => s.save)
  const toggleActive = useStore((s) => s.toggleActive)
  const tags = useStore((s) => s.workflow.tags)
  const setTags = useStore((s) => s.setTags)
  const setDrawerOpen = useStore((s) => s.setDrawerOpen)
  const newWorkflow = useStore((s) => s.newWorkflow)
  const [tagInput, setTagInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const handleSave = async () => {
    try {
      await save()
      setNotice('Saved')
      setTimeout(() => setNotice(null), 1500)
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  const handleToggle = async () => {
    try {
      await toggleActive()
    } catch (err) {
      setNotice((err as Error).message)
      setTimeout(() => setNotice(null), 2500)
    }
  }

  return (
    <header className="flex h-14 min-w-0 flex-none items-center gap-2 overflow-hidden border-b border-line bg-surface px-3 sm:gap-3">
      <button
        onClick={() => setDrawerOpen(true)}
        className="flex flex-none items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink-dim hover:border-accent hover:text-accent"
      >
        <Plus size={13} strokeWidth={2.5} /> Node
      </button>

      <span className="hidden flex-none text-[15px] font-bold tracking-tight text-accent sm:inline">FlowOps</span>

      <input
        className="w-0 min-w-[80px] max-w-[280px] flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[13.5px] font-semibold outline-none hover:border-line focus:border-accent focus:bg-canvas"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation() }}
        aria-label="Workflow name"
      />

      {/* Active toggle */}
      <label className="flex flex-none items-center gap-2" title="When active, webhooks and cron schedules are live">
        <button
          role="switch"
          aria-checked={active}
          onClick={handleToggle}
          className={`relative h-5 w-9 rounded-full transition-colors ${active ? 'bg-ok' : 'bg-surface-3'}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${active ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
        <span className={`hidden text-[11.5px] font-semibold sm:inline ${active ? 'text-ok' : 'text-ink-faint'}`}>
          {active ? 'Active' : 'Inactive'}
        </span>
      </label>

      {/* Tags (hidden on narrow screens) */}
      <div className="hidden min-w-0 items-center gap-1 md:flex">
        {tags.map((t) => (
          <span key={t} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-dim">{t}</span>
        ))}
        <input
          className="w-24 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-ink-faint/50 hover:border-line focus:border-accent"
          placeholder="+ tag"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation()
            if (e.key === 'Enter' && tagInput.trim()) {
              setTags([...new Set([...tags, tagInput.trim()])])
              setTagInput('')
            }
          }}
        />
      </div>

      <span className="ml-auto" />

      {notice && <span className="min-w-0 truncate text-[11.5px] text-ink-dim">{notice}</span>}
      {dirty && !notice && <span className="hidden flex-none text-[11px] text-ink-faint md:inline">Unsaved changes</span>}

      <button onClick={handleSave} disabled={saving} title={dirty ? 'Unsaved changes' : 'Save'} className="relative flex flex-none items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface-3 disabled:opacity-50">
        <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        {dirty && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent md:hidden" aria-hidden="true" />}
      </button>
      <button
        onClick={() => confirm('Delete this workflow?') && newWorkflow()}
        className="flex-none rounded-lg p-2 text-ink-faint hover:bg-err/10 hover:text-err"
        title="Delete workflow"
      >
        <Trash2 size={14} />
      </button>
      <button className="hidden flex-none rounded-lg p-2 text-ink-faint hover:bg-surface-2 sm:block" title="History (roadmap)">
        <Menu size={14} />
      </button>
    </header>
  )
}
