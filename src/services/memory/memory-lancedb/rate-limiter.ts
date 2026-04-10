/**
 * Extraction Rate Limiter — Prevents excessive LLM extraction calls.
 *
 * Uses a sliding-window approach: tracks extraction timestamps in the
 * last hour and rejects new extractions when the limit is exceeded.
 */

import { logger } from '../../../logger.js';

export class ExtractionRateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerHour: number = 30) {}

  /**
   * Check if we're currently rate-limited.
   */
  isRateLimited(): boolean {
    this.pruneStale();
    return this.timestamps.length >= this.maxPerHour;
  }

  /**
   * Record a new extraction. Call this after a successful extraction.
   */
  recordExtraction(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * Get current usage stats.
   */
  getStats(): { used: number; limit: number; windowMs: number } {
    this.pruneStale();
    return {
      used: this.timestamps.length,
      limit: this.maxPerHour,
      windowMs: 3600_000,
    };
  }

  /**
   * Remove timestamps older than the 1-hour window.
   */
  private pruneStale(): void {
    const cutoff = Date.now() - 3600_000;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  /**
   * Convenience: check + log if rate-limited.
   * Returns true if the extraction should proceed, false if blocked.
   */
  tryAcquire(scope: string): boolean {
    if (this.isRateLimited()) {
      const stats = this.getStats();
      logger.info(
        { scope, ...stats },
        'Smart extraction rate-limited, skipping this round',
      );
      return false;
    }
    this.recordExtraction();
    return true;
  }
}
