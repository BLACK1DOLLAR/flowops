import 'dotenv/config'
import { createHash } from 'node:crypto'

const isProduction = process.env.NODE_ENV === 'production'
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 5175)

export const config = {
  port,
  // Loopback by default: the API can run arbitrary Code-node JavaScript, so it
  // must never be reachable from the network without authentication.
  host,
  isProduction,
  // PUBLIC_ACCESS=true: anyone can use the editor and API with no token. The
  // Code node is switched off in this mode, because it can run arbitrary code
  // on the server (and read its secrets).
  publicAccess: process.env.PUBLIC_ACCESS === 'true',
  // When set, every /api request must send `Authorization: Bearer <token>`.
  apiToken: process.env.PUBLIC_ACCESS === 'true' ? '' : process.env.API_TOKEN ?? '',
  // Comma-separated browser origins allowed to call the API. Empty = no
  // cross-origin access (the editor talks to the API through the Vite proxy).
  corsOrigins: (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Public base URL, used to build resume links for Wait nodes.
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  // When set, the server uses PostgreSQL for persistence; otherwise an
  // auto-persisting in-memory store (JSON file) is used so the app runs
  // with zero external dependencies.
  databaseUrl: process.env.DATABASE_URL ?? '',
  // When set, production webhook executions go through Redis + BullMQ;
  // otherwise an in-process queue with retries is used.
  redisUrl: process.env.REDIS_URL ?? '',
  dataFile: process.env.DATA_FILE ?? 'data/memory-store.json',
  encryptionKey: createHash('sha256')
    .update(process.env.ENCRYPTION_KEY ?? 'flowops-dev-key-change-me')
    .digest(), // 32 bytes for AES-256
}

const isLoopback = (h: string) => ['127.0.0.1', 'localhost', '::1'].includes(h)

/** Refuse to start in configurations that would expose the server unsafely. */
export function assertSafeConfig(): void {
  if (!process.env.ENCRYPTION_KEY) {
    if (isProduction) {
      throw new Error('ENCRYPTION_KEY must be set when NODE_ENV=production (credentials would use a public default key).')
    }
    console.warn('[config] ENCRYPTION_KEY not set — using a derived development key. Set it in production.')
  }
  if (config.publicAccess) {
    console.warn('[config] PUBLIC_ACCESS=true — no API token required; anyone can view, edit and run workflows. The Code node is disabled.')
    return
  }
  if (!isLoopback(config.host) && !config.apiToken) {
    throw new Error(
      `HOST=${config.host} exposes the API beyond this machine. Set API_TOKEN so requests must authenticate, set PUBLIC_ACCESS=true to allow anyone in (Code node disabled), or bind to 127.0.0.1.`,
    )
  }
}
