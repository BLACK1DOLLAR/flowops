import 'dotenv/config'
import { createHash } from 'node:crypto'

export const config = {
  port: Number(process.env.PORT ?? 5175),
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

if (!process.env.ENCRYPTION_KEY) {
  console.warn('[config] ENCRYPTION_KEY not set — using a derived development key. Set it in production.')
}
