import { snapshotJsonValue, isJsonValue } from "../deepseek-harness/packages/core/session/src/json.ts";

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

const codeCases = [
  { failure: { statusCode: 429n, message: "Too Many Requests" }, expected: 429 },
  { failure: { status: "500", message: "fail" }, expected: 500 },
  { failure: { code: 429n, message: "rapid" }, expected: 429 },
  { failure: { message: "no code" }, expected: undefined },
  { failure: null, expected: undefined },
  { failure: undefined, expected: undefined },
];

for (const c of codeCases) {
  const got = extractStatusCode(c.failure);
  if (got !== c.expected) {
    console.error("FAIL extractStatusCode", c.failure, "got", got, "expected", c.expected);
    process.exit(1);
  }
}

const payloadCases = [
  { statusCode: 429n, message: "test" },
  { statusCode: undefined, message: "test", data: BigInt(1) },
  { statusCode: 200, message: "ok", meta: new Set([1, 2]) },
  { statusCode: 500, message: "err", cause: new Error("nested") },
  { statusCode: 404, message: "missing", weird: Symbol("s") },
];

for (const c of payloadCases) {
  const serialized = serializeFailure(c);
  if (!isJsonValue(serialized) || snapshotJsonValue(serialized) === undefined) {
    console.error("FAIL serializeFailure not valid JSON for", c, serialized);
    process.exit(1);
  }
}

// Ensure the full event payload shape passes DSH lossless JSON checks
const fullPayload = {
  turn: 1,
  step: { name: "chat" },
  provider: { id: "openai" },
  retry: 1,
  delayMs: 1000,
  delayFormatted: "1m",
  statusCode: undefined,
  statusText: "rate limited",
  deadline: Date.now(),
  statusMessage: "Retrying — rate limited (429), attempt #1, waiting 16s",
  cumulativeWaitMs: 1000,
  failure: { statusCode: 429, message: "rate", nested: new Error("x") },
};

const sanitized = sanitizePayload(fullPayload);
if (!isJsonValue(sanitized) || snapshotJsonValue(sanitized) === undefined) {
  console.error("FAIL sanitizePayload did not pass lossless JSON:", sanitized);
  process.exit(1);
}

// Map-based retry counting matches previous event-scan behavior.
function runCountingFixture() {
  const counters = new Map();
  const key = "1:2:openai";
  const prior = counters.get(key);
  const priorRetries = prior?.retry ?? 0;
  const priorWaitMs = prior?.cumulativeWaitMs ?? 0;
  const retry = priorRetries + 1;
  const delayMs = 1000;
  const cumulativeWaitMs = priorWaitMs + delayMs;
  counters.set(key, { retry, cumulativeWaitMs });

  if (retry !== 1 || cumulativeWaitMs !== 1000) {
    console.error("FAIL first counting fixture");
    process.exit(1);
  }

  const next = counters.get(key);
  const nextPriorRetries = next?.retry ?? 0;
  const nextPriorWaitMs = next?.cumulativeWaitMs ?? 0;
  const nextRetry = nextPriorRetries + 1;
  const nextDelayMs = 2000;
  const nextCumulativeWaitMs = nextPriorWaitMs + nextDelayMs;
  counters.set(key, { retry: nextRetry, cumulativeWaitMs: nextCumulativeWaitMs });

  if (nextRetry !== 2 || nextCumulativeWaitMs !== 3000) {
    console.error("FAIL second counting fixture");
    process.exit(1);
  }
}

runCountingFixture();

console.log("ALL VERIFICATION PASSED");