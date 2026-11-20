import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { Canvas } from './components/Canvas'
import { NodeDrawer } from './components/NodeDrawer'
import { Inspector } from './components/Inspector'
import { LogsDrawer } from './components/LogsDrawer'
import { HistoryPanel } from './components/HistoryPanel'
import { TokenPrompt } from './components/TokenPrompt'
import { useStore } from './store'

const isEditable = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

export default function App() {
  const refreshCredentials = useStore((s) => s.refreshCredentials)

  useEffect(() => {
    refreshCredentials().catch(() => {})
  }, [refreshCredentials])

  // Editor shortcuts. Text fields keep their own undo/copy/paste.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const s = useStore.getState()
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void s.save().catch(() => {})
        return
      }
      if (isEditable(e.target) || s.credentialsOpen) return
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        s.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        s.redo()
      } else if (key === 'c' && s.selectedNodeId && !s.inspectorOpen) {
        e.preventDefault()
        void s.copySelection()
      } else if (key === 'v' && !s.inspectorOpen) {
        e.preventDefault()
        void s.pasteFromClipboard()
      } else if (key === 'd' && s.selectedNodeId && !s.inspectorOpen) {
        e.preventDefault()
        s.duplicateSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Warn before closing the tab with unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <Canvas />
        <NodeDrawer />
        <LogsDrawer />
        <HistoryPanel />
        <Inspector />
      </div>
      <TokenPrompt />
    </div>
  )
}
