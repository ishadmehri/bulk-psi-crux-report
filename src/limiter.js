/**
 * Concurrency cap + optional requests-per-minute ceiling.
 *
 * CrUX allows 150 queries/minute per project and there is no way to buy more,
 * so going over is not a soft failure — it is a wall. The rate window here is a
 * sliding one-minute log rather than a fixed bucket, because a fixed bucket lets
 * you fire 150 at 00:59 and another 150 at 01:00.
 */
export class Limiter {
  constructor({ concurrency = 5, perMinute = 0 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.perMinute = perMinute;
    this.active = 0;
    this.queue = [];
    this.timestamps = [];
  }

  async #slot() {
    if (!this.perMinute) return;
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60000);
      if (this.timestamps.length < this.perMinute) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 60000 - (now - this.timestamps[0]) + 25;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      (async () => {
        try {
          await this.#slot();
          job.resolve(await job.fn());
        } catch (e) {
          job.reject(e);
        } finally {
          this.active--;
          this.#pump();
        }
      })();
    }
  }

  /** Map with the limiter applied; results keep input order. */
  async map(items, fn, onProgress) {
    let done = 0;
    return Promise.all(items.map((item, i) =>
      this.run(async () => {
        const out = await fn(item, i);
        done++;
        if (onProgress) onProgress(done, items.length);
        return out;
      })
    ));
  }
}
