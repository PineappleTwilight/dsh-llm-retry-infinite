/**
 * dsh-llm-retry-infinite
 *
 * DSH plugin that applies infinite exponential retries to every LLM request
 * failure, with each individual wait period capped at 10 minutes.
 *
 * Backoff schedule:
 *   delay_n = min(initialDelayMs * 2^n, MAX_DELAY_MS)
 *
 * Default initial delay: 1 000 ms (1 s)
 * Maximum delay:         600 000 ms (10 min)
 * Default jitter ratio:  0.1  (±10 %)
 *
 * Usage in cordis.patch.yml:
 *
 *   - name: dsh-llm-retry-infinite
 *     config:
 *       initialDelayMs: 1000   # optional, default 1000
 *       maxDelayMs: 600000     # optional, default 600000 (10 min)
 *       jitterRatio: 0.1       # optional, default 0.1
 */

import z from "@deepseek-ai/schemastery";

const name = "llm-retry-infinite";
const inject = ["agents"];

/** Absolute ceiling for a single wait period (10 minutes). */
const HARD_MAX_DELAY_MS = 600_000;

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 600_000; // 10 minutes
const DEFAULT_JITTER_RATIO = 0.1;

/**
 * Validate the plugin config (called once at apply time).
 */
function validateConfig(config) {
  const { initialDelayMs, maxDelayMs, jitterRatio } = config;

  if (initialDelayMs !== undefined) {
    if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
      throw new Error(
        `dsh-llm-retry-infinite: initialDelayMs must be a positive finite number, got ${initialDelayMs}`
      );
    }
    if (initialDelayMs > HARD_MAX_DELAY_MS) {
      throw new Error(
        `dsh-llm-retry-infinite: initialDelayMs must be ≤ ${HARD_MAX_DELAY_MS} ms (10 min), got ${initialDelayMs}`
      );
    }
  }

  if (maxDelayMs !== undefined) {
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
      throw new Error(
        `dsh-llm-retry-infinite: maxDelayMs must be a positive finite number, got ${maxDelayMs}`
      );
    }
    if (maxDelayMs > HARD_MAX_DELAY_MS) {
      throw new Error(
        `dsh-llm-retry-infinite: maxDelayMs must be ≤ ${HARD_MAX_DELAY_MS} ms (10 min), got ${maxDelayMs}`
      );
    }
  }

  if (jitterRatio !== undefined) {
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new Error(
        `dsh-llm-retry-infinite: jitterRatio must be between 0 and 1, got ${jitterRatio}`
      );
    }
  }

  if (
    initialDelayMs !== undefined &&
    maxDelayMs !== undefined &&
    initialDelayMs > maxDelayMs
  ) {
    throw new Error(
      `dsh-llm-retry-infinite: initialDelayMs (${initialDelayMs}) must be ≤ maxDelayMs (${maxDelayMs})`
    );
  }
}

/**
 * Compute the next exponential backoff delay in milliseconds.
 *
 * @param {number} retry    - 1-based retry number (1 = first retry after initial failure)
 * @param {number} initial  - base delay in ms
 * @param {number} cap      - maximum delay in ms (10 min hard cap)
 * @param {number} jitter   - symmetric jitter ratio ∈ [0, 1]
 * @param {() => number} random - random source (injectable for determinism in tests)
 * @returns {number} delay in ms, capped at `cap`, with jitter applied
 */
function computeDelay(retry, initial, cap, jitter, random) {
  // Exponent is clamped to avoid overflow; 2^30 ≈ 1 billion, far beyond any
  // realistic retry count, and initial * 2^30 will always hit the cap first.
  const exponent = Math.min(retry - 1, 30);
  const exponential = Math.min(initial * 2 ** exponent, cap);
  const jitterFactor = 1 - jitter + 2 * jitter * random();
  return Math.min(exponential * jitterFactor, cap);
}

/**
 * Cancellable delay that resolves `true` when the timer fires, or `false` if
 * the abort signal fires first.
 */
function cancellableDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Core recovery handler. Runs on every `agent/request-error` event.
 *
 * Strategy:
 *   1. Do NOT delegate to downstream plugins — we own the retry chain.
 *   2. Record an `llm/retry-infinite` event with retry metadata.
 *   3. Wait for the computed exponential delay (cancellable).
 *   4. Return `{ kind: 'retry' }` to tell the agent loop to re-attempt.
 *
 * There is no retry limit — retries continue until success, cancellation,
 * or plugin disposal.
 */
async function recover({ agent, turn, step, provider, failure, signal }, _next, ctx, config, random) {
  // Do NOT call next() — the built-in dsh-llm-retry would intercept with
  // its default 2-retry cap.  We own the entire retry chain.

  const fusedSignal = AbortSignal.any([signal, ctx._retryInfiniteLifetime.signal]);
  if (fusedSignal.aborted) return;

  // Find how many times we have already retried for this turn+step+provider.
  const priorRetries = agent.session.events.filter(
    (e) =>
      e.type === "llm/retry-infinite" &&
      e.data.turn === turn &&
      e.data.step === step &&
      e.data.provider === provider
  );
  const retry = priorRetries.length + 1;

  const delayMs = computeDelay(
    retry,
    config.initialDelayMs,
    config.maxDelayMs,
    config.jitterRatio,
    random
  );

  // Append a durable retry event (non-surface, not shown to the model).
  agent.session.append("llm/retry-infinite", {
    turn,
    step,
    provider,
    retry,
    delayMs,
    failure,
  });

  ctx.logger.info(
    "dsh-llm-retry-infinite: provider=%s retry=%d delay=%dms",
    provider,
    retry,
    Math.round(delayMs)
  );

  if (!(await cancellableDelay(delayMs, fusedSignal))) return;

  agent.session.append("llm/retry-infinite-started", {
    turn,
    step,
    retry,
  });

  return { kind: "retry" };
}

/**
 * Plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 * @param {{ random?: () => number }} [internals]
 */
function apply(ctx, config = {}, internals = {}) {
  validateConfig(config);

  const resolved = {
    initialDelayMs: config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: Math.min(config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, HARD_MAX_DELAY_MS),
    jitterRatio: config.jitterRatio ?? DEFAULT_JITTER_RATIO,
  };

  const random = internals.random ?? Math.random;
  const lifetime = new AbortController();
  ctx._retryInfiniteLifetime = lifetime;

  const active = new Set();
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  const disposeListener = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next, ctx, resolved, random));
  });

  ctx.effect(
    () => async () => {
      disposeListener();
      lifetime.abort(new Error("dsh-llm-retry-infinite plugin disposed"));
      await Promise.allSettled([...active]);
    },
    "dsh-llm-retry-infinite: abort and drain active recovery"
  );
}

const Config = z.object({});

export { name, inject, Config, apply };
