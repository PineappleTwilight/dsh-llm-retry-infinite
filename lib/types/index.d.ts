/**
 * dsh-llm-retry-infinite
 *
 * DSH plugin that applies infinite exponential retries to every LLM request
 * failure, with each individual wait period capped at 10 minutes.
 *
 * @module dsh-llm-retry-infinite
 */
import type { Context } from "@deepseek-ai/cordis";

export declare const name = "llm-retry-infinite";
export declare const inject: string[];

/**
 * Plugin configuration. All fields are optional and default to the values
 * shown in the JSDoc comments.
 */
export interface Config {
  /**
   * Base delay in milliseconds for the first retry.
   * Subsequent retries double this value up to `maxDelayMs`.
   * @default 1000
   */
  initialDelayMs?: number;

  /**
   * Maximum delay in milliseconds for any single wait period.
   * Capped at 600 000 ms (10 minutes) regardless of configuration.
   * @default 600000
   */
  maxDelayMs?: number;

  /**
   * Symmetric jitter ratio ∈ [0, 1]. The actual delay is multiplied by
   * a random factor in [1 - jitter, 1 + jitter].
   * @default 0.1
   */
  jitterRatio?: number;
}

/** Non-serializable hooks for deterministic test timing. */
export interface RetryInternals {
  /** Random sample in [0, 1] used for jitter calculation. */
  random?: () => number;
}

/**
 * Live retry state, returned by `ctx.retryState()`.
 * Updated on every retry event; the UI can poll this for real-time display.
 */
export interface RetryState {
  /** Whether a retry is currently in progress (waiting). */
  active: boolean;

  /** The agent turn that is being retried. */
  turn?: number;

  /** The step within the turn. */
  step?: number;

  /** The provider that failed (e.g. "openai", "anthropic"). */
  provider?: string;

  /** 1-based retry attempt number (1 = first retry after initial failure). */
  retry?: number;

  /** The computed delay for this retry in milliseconds. */
  delayMs?: number;

  /** Human-readable delay string (e.g. "16s", "2m 8s"). */
  delayFormatted?: string;

  /** Absolute timestamp (ms since epoch) when the wait ends. */
  deadline?: number;

  /** HTTP status code from the failure, if available. */
  statusCode?: number;

  /** Human-readable status label (e.g. "rate limited", "server error"). */
  statusText?: string;

  /** Combined status message for display (e.g. "Retrying — rate limited (429), attempt #3, waiting 16s"). */
  statusMessage?: string;

  /** Cumulative time spent waiting across all retries for this turn+step+provider. */
  cumulativeWaitMs?: number;

  /** Remaining milliseconds until the wait ends (computed on read). */
  remainingMs?: number;

  /** Human-readable remaining time (e.g. "4s"). */
  remainingFormatted?: string;
}

/**
 * Enriched event data emitted with each `llm/retry-infinite` event.
 */
export interface RetryEventData {
  turn: number;
  step: number;
  provider: string;
  retry: number;
  delayMs: number;
  delayFormatted: string;
  statusCode: number | undefined;
  statusText: string;
  deadline: number;
  statusMessage: string;
  cumulativeWaitMs: number;
  failure: unknown;
}

/**
 * Event data for `llm/retry-infinite-started` (fired when wait ends, about to retry).
 */
export interface RetryStartedEventData {
  turn: number;
  step: number;
  retry: number;
  provider: string;
  deadline: number;
}

/**
 * Event data for `llm/retry-infinite-cancelled` (fired when retry is aborted).
 */
export interface RetryCancelledEventData {
  turn: number;
  step: number;
  retry: number;
  provider: string;
  cumulativeWaitMs: number;
}

/**
 * Install infinite exponential retries for every LLM request failure.
 *
 * @param ctx   - Cordis plugin context
 * @param config - backoff parameters (all optional)
 * @param internals - test hooks (optional)
 */
export declare function apply(
  ctx: Context,
  config?: Config,
  internals?: RetryInternals
): void;

/**
 * Get the current live retry state for UI display.
 * Returns `{ active: false }` when no retry is in progress.
 *
 * @example
 *   const state = ctx.retryState();
 *   if (state.active) {
 *     console.log(state.statusMessage);
 *     console.log(`${state.remainingFormatted} remaining`);
 *   }
 */
export declare function retryState(): RetryState;
