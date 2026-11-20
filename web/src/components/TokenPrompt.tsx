import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { setTokenAsker } from '../api'

/**
 * In-app dialog for the server's API_TOKEN. Registered with api.ts so any
 * request that gets a 401 can ask for the token without window.prompt().
 */
export function TokenPrompt() {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [value, setValue] = useState('')
  const resolver = useRef<((token: string | null) => void) | null>(null)

  useEffect(() => {
    setTokenAsker(({ invalid }) =>
      new Promise<string | null>((resolve) => {
        resolver.current = resolve
        setInvalid(invalid)
        setValue('')
        setOpen(true)
      }),
    )
    return () => setTokenAsker(null)
  }, [])

  const finish = (token: string | null) => {
    setOpen(false)
    resolver.current?.(token)
    resolver.current = null
  }

  if (!open) return null

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        className="w-full max-w-sm rounded-xl border border-line-strong bg-surface p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) finish(value.trim())
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') finish(null)
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <h2 className="text-[14px] font-semibold">API token required</h2>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-ink-dim">
          {invalid
            ? 'That token was not accepted. Enter the API_TOKEN this FlowOps server was started with.'
            : 'This FlowOps server is protected. Enter the API_TOKEN it was started with. It is remembered in this browser.'}
        </p>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="API token"
          aria-label="API token"
          className="mb-4 w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[12.5px] outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => finish(null)} className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:bg-surface-2">
            Cancel
          </button>
          <button type="submit" disabled={!value.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-strong disabled:opacity-40">
            Unlock
          </button>
        </div>
      </form>
    </div>
  )
}
