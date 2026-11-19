import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { Canvas } from './components/Canvas'
import { NodeDrawer } from './components/NodeDrawer'
import { Inspector } from './components/Inspector'
import { LogsDrawer } from './components/LogsDrawer'
import { useStore } from './store'

export default function App() {
  const refreshCredentials = useStore((s) => s.refreshCredentials)

  useEffect(() => {
    refreshCredentials()
  }, [refreshCredentials])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <Canvas />
        <NodeDrawer />
        <LogsDrawer />
        <Inspector />
      </div>
    </div>
  )
}
