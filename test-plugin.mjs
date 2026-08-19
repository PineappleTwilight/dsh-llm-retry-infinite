import { Context } from "@deepseek-ai/cordis";
import * as plugin from "./lib/index.js";
import {
  statusIndicator,
  renderTerminalStatus,
  renderHTMLIndicator,
  renderMarkdownStatus,
} from "./lib/display/index.js";
import { snapshotJsonValue, isJsonValue } from "../deepseek-harness/packages/core/session/src/json.ts";

console.log("Starting dsh-llm-retry-infinite test suite...");

// 1. Basic Plugin exports check
if (plugin.name !== "llm-retry-infinite") {
  console.error("FAIL: plugin name is", plugin.name);
  process.exit(1);
}

if (!Array.isArray(plugin.inject) || !plugin.inject.includes("agents")) {
  console.error("FAIL: plugin inject is", plugin.inject);
  process.exit(1);
}

// 2. Test Cordis context integration & session event validation
const ctx = new Context();
ctx.provide("agents");
ctx.agents = {};

plugin.apply(ctx, { initialDelayMs: 5, maxDelayMs: 15, jitterRatio: 0 });

const events = [];
const mockAgent = {
  session: {
    events,
    append(type, data) {
      // Validate that data strictly passes DSH lossless JSON requirements
      const snap = snapshotJsonValue(data);
      if (snap === undefined) {
        throw new Error(`session event "${type}" carries non-JSON-serializable data`);
      }
      if (!isJsonValue(data)) {
        throw new Error(`session event "${type}" isJsonValue returned false`);
      }
      const event = { type, seq: events.length, time: Date.now(), data: snap };
      events.push(event);
      return event;
    },
  },
};

const testFailures = [
  // Missing status code (the primary bug reproduction case)
  { message: "Connection reset by peer", code: "ECONNRESET" },
  new Error("Raw node error with stack"),
  { statusCode: 429, message: "Rate limit reached" },
  { status: "503", message: "Service temporarily unavailable" },
  { code: 500n, message: "Internal server error with bigint" },
  { message: "Exotic error", fn: () => 123, sym: Symbol("exotic"), map: new Map([["a", 1]]), set: new Set([1, 2]) },
  { date: new Date(), inf: Infinity, nan: NaN, negZero: -0 },
  (() => {
    const cyclic = { message: "cyclic error" };
    cyclic.self = cyclic;
    return cyclic;
  })(),
  (() => {
    const sparse = Array(5);
    sparse[0] = "sparse1";
    sparse[3] = "sparse2";
    return { message: "sparse array error", sparse };
  })(),
  null,
  undefined,
  "string failure",
];

for (let i = 0; i < testFailures.length; i++) {
  const failure = testFailures[i];
  const payload = {
    agent: mockAgent,
    turn: i + 1,
    step: 1,
    provider: "deepseek",
    failure,
    signal: new AbortController().signal,
  };

  const beforeCount = events.length;
  const result = await ctx.waterfall("agent/request-error", payload, async () => ({ kind: "fallback" }));
  if (result?.kind !== "retry") {
    console.error(`FAIL: test case ${i} did not return retry decision:`, result);
    process.exit(1);
  }
  if (events.length <= beforeCount) {
    console.error(`FAIL: test case ${i} did not append events`);
    process.exit(1);
  }
}

console.log(`Passed ${testFailures.length} recovery scenarios; emitted ${events.length} session events.`);

// 3. Test retryState() and display helpers
const state = ctx.retryState();
console.log("Current retryState():", state);
if (typeof state !== "object") {
  console.error("FAIL: retryState() is not an object");
  process.exit(1);
}

const mockActiveState = {
  active: true,
  turn: 1,
  step: 1,
  provider: "deepseek",
  retry: 3,
  delayMs: 16000,
  delayFormatted: "16s",
  deadline: Date.now() + 4000,
  statusCode: 429,
  statusText: "rate limited",
  statusMessage: "Retrying — rate limited (429), attempt #3, waiting 16s",
  cumulativeWaitMs: 28000,
  remainingMs: 4000,
  remainingFormatted: "4s",
};

const termStatus = renderTerminalStatus(mockActiveState);
const htmlStatus = renderHTMLIndicator(mockActiveState);
const mdStatus = renderMarkdownStatus(mockActiveState);

if (!termStatus.includes("429") || !termStatus.includes("16s")) {
  console.error("FAIL: renderTerminalStatus output unexpected:", termStatus);
  process.exit(1);
}

if (!htmlStatus.includes("dsh-retry-indicator") || !htmlStatus.includes("429")) {
  console.error("FAIL: renderHTMLIndicator output unexpected:", htmlStatus);
  process.exit(1);
}

if (!mdStatus.includes("Retrying #3") || !mdStatus.includes("429")) {
  console.error("FAIL: renderMarkdownStatus output unexpected:", mdStatus);
  process.exit(1);
}

// 4. Test abort / cancellation path
const abortCtrl = new AbortController();
const abortPromise = ctx.waterfall("agent/request-error", {
  agent: mockAgent,
  turn: 99,
  step: 1,
  provider: "deepseek",
  failure: { message: "aborted test" },
  signal: abortCtrl.signal,
}, async () => ({ kind: "fallback" }));

abortCtrl.abort();
await abortPromise;

const cancelledEvent = events.find((e) => e.type === "llm/retry-infinite-cancelled");
if (!cancelledEvent) {
  console.error("FAIL: cancelled event was not appended");
  process.exit(1);
}

console.log("ALL TESTS PASSED SUCCESSFULLY!");