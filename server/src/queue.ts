import { config } from './config.js'

export interface Job<T = unknown> {
  name: string
  data: T
  attemptsMade: number
}

type Processor<T> = (job: Job<T>) => Promise<void>

export interface JobQueue {
  enqueue(name: string, data: unknown, opts?: { attempts?: number }): Promise<void>
  start(processor: Processor<never>): Promise<void>
  close(): Promise<void>
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 2000

/**
 * Production queue: Redis + BullMQ (used when REDIS_URL is configured).
 * Jobs get exponential backoff retries handled by BullMQ itself.
 */
class BullMQQueue implements JobQueue {
  private processor: Processor<never> | null = null

  constructor(private connection: { url: string }) {}

  async enqueue(name: string, data: unknown): Promise<void> {
    const { Queue } = await import('bullmq')
    const queue = new Queue('flowops', { connection: this.connection })
    await queue.add(name, data, {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_DELAY_MS },
      removeOnComplete: 100,
      removeOnFail: 200,
    })
    await queue.close()
  }

  async start(processor: Processor<never>): Promise<void> {
    this.processor = processor
    const { Worker } = await import('bullmq')
    const worker = new Worker(
      'flowops',
      async (job: any) => {
        await this.processor?.({ name: job.name, data: job.data, attemptsMade: job.attemptsMade } as never)
      },
      { connection: this.connection },
    )
    worker.on('failed', (job: any, err: Error) =>
      console.error(`[queue] job ${job?.name}#${job?.id} failed: ${err.message}`),
    )
  }

  async close(): Promise<void> {}
}

/**
 * Fallback queue: in-process, with retry + exponential backoff.
 * Runs jobs concurrently in the background.
 */
class InlineQueue implements JobQueue {
  private processor: Processor<never> | null = null

  async enqueue(name: string, data: unknown): Promise<void> {
    void this.run({ name, data, attemptsMade: 0 })
  }

  private async run(job: Job): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.processor?.(job as never)
        return
      } catch (err) {
        console.error(`[queue] job "${job.name}" attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error).message}`)
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * 2 ** (attempt - 1)))
        }
      }
    }
    console.error(`[queue] job "${job.name}" permanently failed after ${MAX_ATTEMPTS} attempts`)
  }

  async start(processor: Processor<never>): Promise<void> {
    this.processor = processor
  }

  async close(): Promise<void> {}
}

export async function createQueue(): Promise<JobQueue> {
  if (config.redisUrl) {
    try {
      // bullmq is optional; if it is not installed we fall back to the inline queue.
      const bullmq = await import('bullmq' as string).catch(() => null)
      if (bullmq) {
        console.log('[queue] Using Redis + BullMQ')
        return new BullMQQueue({ url: config.redisUrl })
      }
      console.warn('[queue] bullmq not installed — using inline queue')
    } catch (err) {
      console.error('[queue] BullMQ unavailable, falling back to inline queue:', (err as Error).message)
    }
  }
  console.log('[queue] Using in-process queue (set REDIS_URL for Redis + BullMQ)')
  return new InlineQueue()
}
