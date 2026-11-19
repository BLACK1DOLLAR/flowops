import { useRef, useState } from 'react'
import { Save, History, Plus, Trash2, Undo2, Redo2, Download, Upload } from 'lucide-react'
import { useStore } from '../store'

export function TopBar() {
  const name = useStore((s) => s.workflow.name)
  const workflowId = useStore((s) => s.workflow.id)
  const setName = useStore((s) => s.setName)
  const active = useStore((s) => s.workflow.active)
  const dirty = useStore((s) => s.dirty)
  const saving = useStore((s) => s.saving)
  const save = useStore((s) => s.save)
  const toggleActive = useStore((s) => s.toggleActive)
  const tags = useStore((s) => s.workflow.tags)
  const setTags = useStore((s) => s.setTags)
  const setDrawerOpen = useStore((s) => s.setDrawerOpen)
  const deleteWorkflow = useStore((s) => s.deleteWorkflow)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const historyOpen = useStore((s) => s.historyOpen)
  const setHistoryOpen = useStore((s) => s.setHistoryOpen)
  const [tagInput, setTagInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const flash = (msg: string, ms = 2500) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), ms)
  }

  const handleSave = async () => {
    try {
      await save()
      flash('Saved', 1500)
    } catch (err) {
      flash((err as Error).message, 5000)
    }
  }

  const handleToggle = async () => {
    try {
      const warning = await toggleActive()
      if (warning) flash(warning, 6000)
    } catch (err) {
      flash((err as Error).message)
    }
  }

  const handleDelete = async () => {
    if (!confirm(workflowId ? `Delete "${name}" and its execution history? This cannot be undone.` : 'Discard this unsaved workflow?')) return
    try {
      await deleteWorkflow()
    } catch (err) {
      flash((err as Error).message)
    }
  }

  const handleExport = () => {
    const blob = new Blob([useStore.getState().exportWorkflow()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (file: File) => {
    try {
      await useStore.getState().importWorkflow(JSON.parse(await file.text()))
      flash('Imported as a new workflow')
    } catch (err) {
      flash(err instanceof SyntaxError ? 'That file is not valid JSON' : (err as Error).message, 5000)
    }
  }

  const iconBtn = 'flex-none rounded-lg p-2 text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'

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
        onKeyDown={(e) => e.stopPropagation()}
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
      <div className="hidden min-w-0 items-center gap-1 lg:flex">
        {tags.map((t) => (
          <button
            key={t}
            onClick={() => setTags(tags.filter((x) => x !== t))}
            title="Remove tag"
            className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-dim hover:border-err hover:text-err"
          >
            {t}
          </button>
        ))}
        <input
          className="w-24 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-ink-faint/50 hover:border-line focus:border-accent"
          placeholder="+ tag"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && tagInput.trim()) {
              setTags([...new Set([...tags, tagInput.trim()])])
              setTagInput('')
            }
          }}
        />
      </div>

      <span className="ml-auto" />

      {notice && <span className="min-w-0 truncate text-[11.5px] text-ink-dim" title={notice}>{notice}</span>}
      {dirty && !notice && <span className="hidden flex-none text-[11px] text-ink-faint md:inline">Unsaved changes</span>}

      <button onClick={undo} disabled={!canUndo} className={`${iconBtn} hidden sm:block`} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={14} /></button>
      <button onClick={redo} disabled={!canRedo} className={`${iconBtn} hidden sm:block`} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={14} /></button>

      <button onClick={handleSave} disabled={saving} title={dirty ? 'Unsaved changes (Ctrl+S)' : 'Save (Ctrl+S)'} className="relative flex flex-none items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface-3 disabled:opacity-50">
        <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        {dirty && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent md:hidden" aria-hidden="true" />}
      </button>

      <button onClick={handleExport} className={`${iconBtn} hidden md:block`} title="Export workflow as JSON" aria-label="Export workflow"><Download size={14} /></button>
      <button onClick={() => fileInput.current?.click()} className={`${iconBtn} hidden md:block`} title="Import workflow from JSON" aria-label="Import workflow"><Upload size={14} /></button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleImport(f)
          e.target.value = ''
        }}
      />

      <button
        onClick={() => setHistoryOpen(!historyOpen)}
        disabled={!workflowId}
        className={`${iconBtn} ${historyOpen ? 'text-accent' : ''}`}
        title={workflowId ? 'Version history' : 'Save the workflow to start its version history'}
        aria-label="Version history"
      >
        <History size={14} />
      </button>
      <button onClick={handleDelete} className="flex-none rounded-lg p-2 text-ink-faint hover:bg-err/10 hover:text-err" title="Delete workflow" aria-label="Delete workflow">
        <Trash2 size={14} />
      </button>
    </header>
  )
}
