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
