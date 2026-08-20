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

import { randomUUID } from "node:crypto";
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
 * Recursively convert a value into a losslessly JSON-serializable plain object/scalar.
 * - Strips functions, symbols, and undefined properties from objects
 * - Converts bigints to strings
 * - Replaces NaN, Infinity, -Infinity with null
 * - Normalizes -0 to 0
 * - Normalizes Dates to ISO strings (or null if invalid)
 * - Normalizes Buffers and Sets to dense arrays
 * - Normalizes Errors to plain objects with name, message, stack, code, status, etc.
 * - Normalizes Maps to plain objects with string keys
 * - Dense-packs arrays and replaces undefined elements with null
 * - Breaks circular references with "[circular]"
 * - Ensures plain object prototypes so DSH snapshotJsonValue accepts them
 */
function serializeValue(value, seen = new Set()) {
  try {
    if (value === null) return null;
    if (value === undefined) return undefined;
    const type = typeof value;
    if (type === "boolean" || type === "string") return value;
    if (type === "number") {
      if (Object.is(value, -0)) return 0;
      if (!Number.isFinite(value)) return null;
      return value;
    }
    if (type === "bigint") return value.toString();
    if (type === "symbol" || type === "function") return undefined;
    if (type !== "object") return undefined;

    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (value instanceof Date) {
      seen.delete(value);
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
      seen.delete(value);
      return Array.from(value);
    }
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const s = serializeValue(value[i], seen);
        result.push(s === undefined ? null : s);
      }
      seen.delete(value);
      return result;
    }
    if (value instanceof Set) {
      const result = [];
      for (const item of value) {
        const s = serializeValue(item, seen);
        if (s !== undefined) result.push(s);
      }
      seen.delete(value);
      return result;
    }
    if (value instanceof Map) {
      const obj = {};
      for (const [k, v] of value.entries()) {
        const s = serializeValue(v, seen);
        if (s !== undefined) obj[String(k)] = s;
      }
      seen.delete(value);
      return obj;
    }
    if (value instanceof Error) {
      const obj = {
        name: String(value.name || "Error"),
        message: String(value.message || ""),
      };
      if (typeof value.stack === "string") obj.stack = value.stack;
      if (value.cause !== undefined) {
        const c = serializeValue(value.cause, seen);
        if (c !== undefined) obj.cause = c;
      }
      if (value.code !== undefined) {
        const c = serializeValue(value.code, seen);
        if (c !== undefined) obj.code = c;
      }
      if (value.status !== undefined) {
        const s = serializeValue(value.status, seen);
        if (s !== undefined) obj.status = s;
      }
      if (value.statusCode !== undefined) {
        const s = serializeValue(value.statusCode, seen);
        if (s !== undefined) obj.statusCode = s;
      }
      for (const key of Object.keys(value)) {
        if (!(key in obj)) {
          const s = serializeValue(value[key], seen);
          if (s !== undefined) obj[key] = s;
        }
      }
      seen.delete(value);
      return obj;
    }

    const obj = {};
    for (const key of Object.keys(value)) {
      const s = serializeValue(value[key], seen);
      if (s !== undefined) {
        obj[key] = s;
      }
    }
    seen.delete(value);
    return obj;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function serializeFailure(failure) {
  if (failure === undefined || failure === null) return failure ?? null;
  return serializeValue(failure, new Set()) ?? null;
}

function sanitizePayload(payload) {
  const result = serializeValue(payload, new Set());
  if (result === undefined || result === null || typeof result !== "object" || Array.isArray(result)) {
    return { payload: result ?? null };
  }
  return result;
}

/**
 * Extract HTTP status code from a failure object.
 * Tries common property names used by different provider adapters.
 */
function extractStatusCode(failure) {
  if (!failure) return undefined;
  const raw =
    failure.statusCode ??
    failure.status ??
    failure.httpStatus ??
    failure.httpStatusCode ??
    failure.code;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
async function recover({ agent, turn, step, provider, failure, signal }, _next, ctx, config, random, counters) {
  // Do NOT call next() — the built-in dsh-llm-retry would intercept with
  // its default 2-retry cap.  We own the entire retry chain.

  const fusedSignal = AbortSignal.any([signal, ctx._retryInfiniteLifetime.signal]);
  if (fusedSignal.aborted) return;

  // Map-based retry counter, cumulative wait tracker, and stable retryId for this turn+step+provider.
  const key = `${turn}:${step}:${provider}`;
  const prior = counters.get(key);
  const priorRetries = prior?.retry ?? 0;
  const priorWaitMs = prior?.cumulativeWaitMs ?? 0;
  const retryId = prior?.retryId ?? randomUUID();
  const retry = priorRetries + 1;

  const delayMs = computeDelay(
    retry,
    config.initialDelayMs,
    config.maxDelayMs,
    config.jitterRatio,
    random
  );

  const cumulativeWaitMs = priorWaitMs + delayMs;
  counters.set(key, { retry, cumulativeWaitMs, retryId });

  const serializedFailure = serializeFailure(failure);
  const statusCode = extractStatusCode(failure);
  const deadline = Date.now() + delayMs;

  const statusText = httpStatusText(statusCode);
  const statusMessage = `Retrying — ${statusText}${statusCode ? ` (${statusCode})` : ""}, attempt #${retry}, waiting ${formatDelay(delayMs)}`;

  // 1. Emit standard llm/retry event for built-in DSH Web UI conversation node renderer
  const failureMessage =
    typeof failure === "string"
      ? failure
      : failure?.message
      ? String(failure.message)
      : String(failure || "LLM request failed");

  const failureCode = failure?.code
    ? String(failure.code)
    : statusCode
    ? `HTTP_${statusCode}`
    : "UNKNOWN";

  const standardFailure = {
    message: failureMessage,
    code: failureCode,
    ...(statusCode !== undefined ? { status: statusCode } : {}),
    ...(failure?.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {}),
    ...(failure?.requestId !== undefined ? { requestId: failure.requestId } : {}),
  };

  const standardRetryPayload = sanitizePayload({
    retryId,
    turn,
    step,
    provider,
    mode: "always",
    policyKey: JSON.stringify(["always", config.initialDelayMs, config.maxDelayMs, config.jitterRatio]),
    retry,
    delayMs,
    failure: standardFailure,
  });

  try {
    agent.session.append("llm/retry", standardRetryPayload);
  } catch (appendStandardError) {
    ctx.logger?.warn?.(
      "dsh-llm-retry-infinite: standard append failed eventType=llm/retry: %s",
      appendStandardError.message
    );
  }

  // 2. Emit enriched llm/retry-infinite event
  const eventPayload = {
    retryId,
    turn,
    step,
    provider,
    retry,
    delayMs,
    delayFormatted: formatDelay(delayMs),
    ...(statusCode !== undefined ? { statusCode } : {}),
    statusText,
    deadline,
    statusMessage,
    cumulativeWaitMs,
    ...(serializedFailure !== undefined ? { failure: serializedFailure } : {}),
  };

  const sanitizedPayload = sanitizePayload(eventPayload);

  try {
    agent.session.append("llm/retry-infinite", sanitizedPayload);
  } catch (appendError) {
    ctx.logger?.info(
      "dsh-llm-retry-infinite: initial append failed eventType=llm/retry-infinite statusCode=%s error=%s",
      statusCode,
      appendError.message
    );
    try {
      const fallbackPayload = sanitizePayload({
        retryId,
        turn,
        step,
        provider,
        retry,
        delayMs,
        delayFormatted: formatDelay(delayMs),
        ...(statusCode !== undefined ? { statusCode } : {}),
        statusText,
        deadline,
        statusMessage,
        cumulativeWaitMs,
        failure: "[omitted: event append failed]",
      });
      agent.session.append("llm/retry-infinite", fallbackPayload);
    } catch (fallbackError) {
      ctx.logger?.error(
        "dsh-llm-retry-infinite: fallback append also failed: %s",
        fallbackError.message
      );
    }
  }

  // Update the live retry state tracker for UI polling.
  ctx._retryInfiniteState = {
    active: true,
    retryId,
    turn,
    step,
    provider,
    retry,
    delayMs,
    delayFormatted: formatDelay(delayMs),
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
    try {
      agent.session.append(
        "llm/retry-infinite-cancelled",
        sanitizePayload({
          retryId,
          turn,
          step,
          retry,
          provider,
          cumulativeWaitMs,
        })
      );
    } catch (e) {
      ctx.logger?.warn("dsh-llm-retry-infinite: cancelled append failed: %s", e.message);
    }
    ctx._retryInfiniteState = { active: false };
    return;
  }

  // Emit standard llm/retry-started event for built-in DSH Web UI
  try {
    agent.session.append("llm/retry-started", {
      retryId,
      turn,
      step,
      retry,
    });
  } catch (e) {
    ctx.logger?.warn("dsh-llm-retry-infinite: retry-started append failed: %s", e.message);
  }

  try {
    agent.session.append(
      "llm/retry-infinite-started",
      sanitizePayload({
        retryId,
        turn,
        step,
        retry,
        provider,
        deadline,
      })
    );
  } catch (e) {
    ctx.logger?.warn("dsh-llm-retry-infinite: started append failed: %s", e.message);
  }

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

  ctx.logger.info(
    "dsh-llm-retry-infinite: apply loaded plugin=llm-retry-infinite bundle=dsh-llm-retry-infinite"
  );

  const resolved = {
    initialDelayMs: config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: Math.min(config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, HARD_MAX_DELAY_MS),
    jitterRatio: config.jitterRatio ?? DEFAULT_JITTER_RATIO,
  };

  const random = internals.random ?? Math.random;
  const lifetime = new AbortController();
  ctx._retryInfiniteLifetime = lifetime;
  const counters = new Map();

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
    return track(recover(payload, next, ctx, resolved, random, counters));
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
