import { useState } from 'react'
import { X } from 'lucide-react'
import { NODE_TYPES, CREDENTIAL_FIELD_DEFS, CREDENTIAL_TYPE_LABELS, credentialAccepts, credentialTypesFor } from '../registry'
import { useStore } from '../store'
import { api } from '../api'

export function CredentialModal() {
  const close = () => useStore.getState().setCredentialsOpen(false)
  const refresh = useStore((s) => s.refreshCredentials)
  const updateCredentialRef = useStore((s) => s.updateCredentialRef)
  const node = useStore((s) => s.workflow.nodes.find((n) => n.id === s.selectedNodeId))
  const slotType = useStore((s) => s.credentialSlotType)
  // Offer only the types the node slot accepts (all types when opened from elsewhere).
  const types = slotType ? credentialTypesFor(slotType).filter((t) => t in CREDENTIAL_FIELD_DEFS) : Object.keys(CREDENTIAL_FIELD_DEFS)
  const [type, setType] = useState(types[0] ?? 'openaiApi')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldDefs = CREDENTIAL_FIELD_DEFS[type] ?? []

  const save = async () => {
    if (!name.trim()) return setError('Give the credential a name.')
    setSaving(true)
    setError(null)
    try {
      const cred = await api.createCredential(name.trim(), type, fields)
      await refresh()
      // Auto-attach to the node slot that expects this credential type.
      if (node) {
        const def = NODE_TYPES[node.type]
        const slot = def?.credentials?.find((s) => (slotType ? s.type === slotType : true) && credentialAccepts(s.type, type))
        if (slot) updateCredentialRef(node.id, slot.key, cred.id)
      }
      close()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/55" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[440px] rounded-xl border border-line-strong bg-surface p-5 shadow-2xl" role="dialog" aria-modal="true">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">New credential</h2>
          <button onClick={close} className="rounded p-1 text-ink-faint hover:text-ink" aria-label="Close"><X size={15} /></button>
        </div>

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-dim">Type</label>
        <select
          className="mb-3 w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
          value={type}
          onChange={(e) => { setType(e.target.value); setFields({}) }}
        >
          {types.map((t) => (
            <option key={t} value={t}>{CREDENTIAL_TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-dim">Name</label>
        <input
          className="mb-3 w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production API key"
        />

        {fieldDefs.map((f) => (
          <div key={f.name} className="mb-3">
            <label className="mb-1 block text-[11.5px] font-semibold text-ink-dim">{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
              value={fields[f.name] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
            />
          </div>
        ))}

        <p className="mb-3 text-[10.5px] leading-snug text-ink-faint">
          Stored AES-256-GCM encrypted on the server. Secrets are never sent back to the browser.
        </p>

        {error && <p className="mb-2 text-[11.5px] text-err">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={close} className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:bg-surface-2">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save credential'}
          </button>
        </div>
      </div>
    </div>
  )
}
