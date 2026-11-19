import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config.js'

/** AES-256-GCM encrypt → "v1.<iv b64>.<tag b64>.<ciphertext b64>" */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split('.')
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted payload')
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

export function encryptJson(data: unknown): string {
  return encrypt(JSON.stringify(data))
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T
}
