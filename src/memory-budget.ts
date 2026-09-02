import { totalmem } from 'node:os'

const MEBIBYTE = 1024 * 1024
const MINIMUM_BUDGET = 64 * MEBIBYTE
const MAXIMUM_BUDGET = 512 * MEBIBYTE

interface Waiter {
  weight: number
  resolve: (release: () => void) => void
}

export class MemoryBudget {
  private readonly limit = Math.max(
    MINIMUM_BUDGET,
    Math.min(MAXIMUM_BUDGET, Math.floor(totalmem() * 0.15))
  )
  private used = 0
  private readonly queue: Waiter[] = []

  acquire(estimatedBytes: number): Promise<() => void> {
    const weight = Math.min(this.limit, Math.max(1, estimatedBytes))
    return new Promise((resolve) => {
      this.queue.push({ weight, resolve })
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (this.used > 0 && this.used + next.weight > this.limit) return

      this.queue.shift()
      this.used += next.weight
      let released = false
      next.resolve(() => {
        if (released) return
        released = true
        this.used -= next.weight
        this.drain()
      })
    }
  }
}
