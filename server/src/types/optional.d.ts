declare module 'bullmq' {
  export class Queue {
    constructor(name: string, opts?: Record<string, unknown>)
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
  }
  export class Worker {
    constructor(name: string, processor: (job: any) => Promise<any>, opts?: Record<string, unknown>)
    on(event: string, cb: (...args: any[]) => void): void
    close(): Promise<void>
  }
}
