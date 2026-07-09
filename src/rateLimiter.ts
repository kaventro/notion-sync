import { activeWindow } from "obsidian";

/**
 * Queue-based rate limiter for Notion API.
 * Enforces max 3 requests/second with exponential backoff on 429 errors.
 */
export class RateLimiter {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly intervalMs: number;
  private lastCallTime = 0;

  constructor(requestsPerSecond = 3, maxConcurrent = 1) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
    this.maxConcurrent = maxConcurrent;
  }

  /** Enqueue a function to be rate-limited */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const item = this.queue.shift();
    if (!item) return;

    this.running++;

    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    const waitTime = Math.max(0, this.intervalMs - elapsed);

    if (waitTime > 0) {
      await this.delay(waitTime);
    }

    this.lastCallTime = Date.now();

    try {
      const result = await this.executeWithRetry(item.fn);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.running--;
      void this.processQueue();
    }
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const errObj = error as Record<string, unknown> | null;
        const isRateLimited = errObj?.status === 429 || errObj?.code === "rate_limited";
        if (!isRateLimited || attempt === maxRetries) throw error;

        const retryAfter = this.parseRetryAfter(error);
        const backoff = retryAfter || Math.min(1000 * Math.pow(2, attempt), 30000);
        await this.delay(backoff);
      }
    }
    throw new Error("Rate limiter: max retries exceeded");
  }

  private parseRetryAfter(error: unknown): number | null {
    const errObj = error as Record<string, unknown> | null;
    const headers = errObj?.headers as Record<string, string> | undefined;
    if (headers) {
      const seconds = parseFloat(headers["retry-after"] ?? "");
      if (!isNaN(seconds)) return seconds * 1000;
    }
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => activeWindow.setTimeout(resolve, ms));
  }

  /** Number of items waiting in the queue */
  get pending(): number {
    return this.queue.length;
  }

  /** Clear all pending items */
  clear(): void {
    for (const item of this.queue) {
      item.reject(new Error("Rate limiter cleared"));
    }
    this.queue = [];
  }
}
