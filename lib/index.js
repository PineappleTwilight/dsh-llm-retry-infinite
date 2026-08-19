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
 * Recursively convert a value into a JSON-safe plain object.
 * Strips functions, normalizes Dates/Buffers/Errors, and breaks
 * circular references so session events remain serializable.
 */
function serializeFailure(failure) {
  if (failure === null || typeof failure === "function") return undefined;
  if (typeof failure !== "object") return failure;
  if (Buffer.isBuffer(failure)) return Array.from(failure);
  return serializeValue(failure, new Set());
}

function serializeValue(value, seen) {
  if (value === null) return null;
  if (typeof value === "function") return undefined;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return Array.from(value);
  if (Array.isArray(value))
    return value
      .map((item) => serializeValue(item, seen))
      .filter((v) => v !== undefined);

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    const obj = { name: value.name, message: value.message };
    if (value.stack) obj.stack = value.stack;
    for (const key of Object.keys(value)) {
      if (!(key in obj)) obj[key] = serializeValue(value[key], seen);
    }
    seen.delete(value);
    return obj;
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = serializeValue(val, seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Extract HTTP status code from a failure object.
 * Tries common property names used by different provider adapters.
 */
function extractStatusCode(failure) {
  if (!failure) return undefined;
  return (
    failure.statusCode ??
    failure.status ??
    failure.httpStatus ??
    failure.httpStatusCode ??
    (typeof failure.code === "number" ? failure.code : undefined)
  );
}

/**
 * Human-readable status label for a given HTTP status code.
 */
function httpStatusText(code) {
  if (code === undefined) return "unknown";
  if (code === 429) return "rate limited";
  if (code === 503) return "service unavailable";
  if (code === 502) return "bad gateway";
  if (code === 500) return "server error";
  if (code === 408) return "timeout";
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 404) return "not found";
  if (code >= 400 && code < 500) return `client error (${code})`;
  if (code >= 500) return `server error (${code})`;
  return `status ${code}`;
}

/**
 * Format a delay in milliseconds as a human-readable string.
 * e.g., "1.2s", "16s", "2m 8s", "10m 0s"
 */
function formatDelay(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Core recovery handler. Runs on every `agent/request-error` event.
 *
 * Strategy:
 *   1. Do NOT delegate to downstream plugins — we own the retry chain.
 *   2. Record an `llm/retry-infinite` event with enriched retry metadata
 *      including status code, countdown deadline, and human-readable status.
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

  const statusCode = extractStatusCode(failure);
  const deadline = Date.now() + delayMs;

  // Compute cumulative wait time for this turn+step+provider.
  const priorWaitMs = priorRetries.reduce((sum, e) => sum + (e.data?.delayMs ?? 0), 0);
  const cumulativeWaitMs = priorWaitMs + delayMs;

  const statusText = httpStatusText(statusCode);
  const statusMessage = `Retrying — ${statusText}${statusCode ? ` (${statusCode})` : ""}, attempt #${retry}, waiting ${formatDelay(delayMs)}`;

  // Append a durable retry event (non-surface, not shown to the model).
  // Enriched fields: statusCode, statusText, deadline, statusMessage,
  // cumulativeWaitMs, delayFormatted.
  agent.session.append("llm/retry-infinite", {
    turn,
    step,
    provider,
    retry,
    delayMs,
    delayFormatted: formatDelay(delayMs),
    statusCode,
    statusText,
    deadline,
    statusMessage,
    cumulativeWaitMs,
    failure: serializeFailure(failure),
  });

  // Update the live retry state tracker for UI polling.
  ctx._retryInfiniteState = {
    active: true,
    turn,
    step,
    provider,
    retry,
    delayMs,
    deadline,
    statusCode,
    statusText,
    statusMessage,
    cumulativeWaitMs,
  };

  ctx.logger.info(
    "dsh-llm-retry-infinite: provider=%s retry=%d status=%s delay=%dms deadline=%d",
    provider,
    retry,
    statusText,
    Math.round(delayMs),
    deadline
  );

  if (!(await cancellableDelay(delayMs, fusedSignal))) {
    // Wait was cancelled (abort/dispose). Emit cancelled event.
    agent.session.append("llm/retry-infinite-cancelled", {
      turn,
      step,
      retry,
      provider,
      cumulativeWaitMs,
    });
    ctx._retryInfiniteState = { active: false };
    return;
  }

  agent.session.append("llm/retry-infinite-started", {
    turn,
    step,
    retry,
    provider,
    deadline,
  });

  // Clear the live state once we're about to retry.
  ctx._retryInfiniteState = { active: false };

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

  // Initialize live retry state (accessible via ctx.retryState()).
  ctx._retryInfiniteState = { active: false };

  const active = new Set();
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  /**
   * Return the current retry state for UI display.
   *
   * @returns {{ active: boolean, turn?: number, step?: number,
   *   provider?: string, retry?: number, delayMs?: number,
   *   deadline?: number, statusCode?: number, statusText?: string,
   *   statusMessage?: string, cumulativeWaitMs?: number }}
   */
  function retryState() {
    const s = ctx._retryInfiniteState;
    if (!s || !s.active) return { active: false };
    // Add live countdown: remaining ms until deadline.
    const remainingMs = Math.max(0, s.deadline - Date.now());
    return { ...s, remainingMs, remainingFormatted: formatDelay(remainingMs || 0) };
  }
  ctx.provide("retryState", retryState);

  const disposeListener = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next, ctx, resolved, random));
  });

  ctx.effect(
    () => async () => {
      disposeListener();
      lifetime.abort(new Error("dsh-llm-retry-infinite plugin disposed"));
      ctx._retryInfiniteState = { active: false };
      await Promise.allSettled([...active]);
    },
    "dsh-llm-retry-infinite: abort and drain active recovery"
  );
}

const Config = z.object({});

export { name, inject, Config, apply };
