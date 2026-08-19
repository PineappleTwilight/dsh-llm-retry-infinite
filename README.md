# `dsh-llm-retry-infinite`

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that replaces the built-in LLM retry behavior with **infinite exponential retries**. Every failed LLM request is retried indefinitely with an exponential backoff that caps each individual wait at **10 minutes**.

## Why this exists

The built-in `@deepseek-ai/dsh-llm-retry` defaults to `mode: 'normal'` with a hard cap of **2 retries**. For environments with transient rate limits, flaky connectivity, or provider instability, you may want the harness to keep trying until the request succeeds — without a retry ceiling. This plugin takes over the entire retry chain and never gives up.

## How it works

1. Intercepts every `agent/request-error` event from the DSH agent loop.
2. Computes an exponential backoff: `min(initialDelayMs × 2^retry, 600 000)`.
3. Waits the computed delay (symmetric jitter, cancellable on abort or session close).
4. Returns `{ kind: 'retry' }` to re-attempt the request.
5. Repeats **forever** until success, cancellation, or plugin disposal.

The plugin **does not delegate** to the built-in retry handler — it fully replaces it.

## Backoff schedule (default config)

| Retry # | Delay      | Approx. |
|---------|------------|---------|
| 1       | 1000 ms    | 1 s     |
| 2       | 2000 ms    | 2 s     |
| 3       | 4000 ms    | 4 s     |
| 4       | 8000 ms    | 8 s     |
| 5       | 16 000 ms  | 16 s    |
| 6       | 32 000 ms  | 32 s    |
| 7       | 64 000 ms  | ~1 m    |
| 8       | 128 000 ms | ~2 m    |
| 9       | 256 000 ms | ~4 m    |
| 10      | 512 000 ms | ~8.5 m  |
| 11+     | 600 000 ms | **10 m** (cap) |

Each value includes ±10 % symmetric jitter by default.

---

## Installation

### 1. Install the package

```bash
cd ~/.dsh/profiles/<your-profile>
pnpm add dsh-llm-retry-infinite
```

For a local / development copy:

```bash
cd ~/.dsh/profiles/<your-profile>
pnpm add "link:/absolute/path/to/dsh-llm-retry-infinite"
```

### 2. Register as a bundle

Open `package.json` in your profile directory and add `"dsh-llm-retry-infinite"` to the `dsh.profile.bundles` array:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // ... other bundles ...
        "dsh-llm-retry-infinite"   // ← add this
      ]
    }
  }
}
```

### 3. Disable the built-in retry plugin

The built-in `@deepseek-ai/dsh-llm-retry` (id: `llm-retry`) is loaded by `dsh-base` and runs **before** any later bundle in the waterfall chain. It must be disabled or it will intercept retries with its 2-attempt cap.

Open `~/.dsh/profiles/<your-profile>/cordis.patch.yml` and add a disable entry:

```yaml
[
  {
    id: "llm-retry",
    disabled: true
  }
]
```

This tells the Cordis loader to skip the built-in retry plugin entirely, leaving `dsh-llm-retry-infinite` as the sole retry handler.

### 4. (Optional) Restart DSH

If DSH is already running, restart it to pick up the new plugin and patch:

```bash
# For the web profile:
# Stop the existing process, then:
dsh web
```

---

## Configuration

All fields are optional. You can pass config through `cordis.patch.yml` or through the bundle's own `config` block:

```yaml
# In cordis.patch.yml — override config for the plugin entry
[
  {
    id: "llm-retry",
    disabled: true
  },
  {
    insert: [
      {
        id: "llm-retry-infinite",
        name: "dsh-llm-retry-infinite",
        config: {
          initialDelayMs: 2000    # base delay for first retry (default: 1000)
          maxDelayMs: 300000      # cap per wait — 5 min (default: 600000)
          jitterRatio: 0.15       # symmetric jitter ±15% (default: 0.1)
        }
      }
    ]
  }
]
```

Or if you rely on the auto-insert from `cordis.patch.yml` inside the plugin package itself, you can override via the profile-level patch:

```yaml
[
  {
    id: "llm-retry",
    disabled: true
  },
  {
    id: "llm-retry-infinite",
    config: {
      initialDelayMs: 500
      maxDelayMs: 600000
      jitterRatio: 0.1
    }
  }
]
```

### Parameter constraints

| Parameter | Type | Default | Range |
|-----------|------|---------|-------|
| `initialDelayMs` | number | 1000 | (0, 600 000] |
| `maxDelayMs` | number | 600 000 | (0, 600 000] |
| `jitterRatio` | number | 0.1 | [0, 1] |

Additional rules:
- `initialDelayMs` must be ≤ `maxDelayMs`.
- The hard ceiling of **600 000 ms (10 minutes)** cannot be exceeded regardless of configuration.

---

## Session events

The plugin emits durable, non-surface session events for observability and UI display:

| Event | When | Payload |
|-------|------|---------|
| `llm/retry-infinite` | Before each wait | `turn`, `step`, `provider`, `retry`, `delayMs`, `delayFormatted`, `statusCode`, `statusText`, `statusMessage`, `deadline`, `cumulativeWaitMs`, `failure` |
| `llm/retry-infinite-started` | After wait completes, just before the retry fires | `turn`, `step`, `retry`, `provider`, `deadline` |
| `llm/retry-infinite-cancelled` | When a retry is aborted (session close, disposal) | `turn`, `step`, `retry`, `provider`, `cumulativeWaitMs` |

These events are **not visible to the model** and do not contribute to token billing. They are available in the session event log for debugging and UI status display.

### Enriched event fields

Each `llm/retry-infinite` event includes rich metadata for UI rendering:

| Field | Type | Description |
|-------|------|-------------|
| `statusCode` | `number \| undefined` | HTTP status code from the failure (429, 500, 503, etc.) |
| `statusText` | `string` | Human-readable status label (e.g. "rate limited", "server error") |
| `statusMessage` | `string` | Full display message: `"Retrying — rate limited (429), attempt #3, waiting 16s"` |
| `deadline` | `number` | Absolute timestamp (ms since epoch) when the wait ends |
| `delayFormatted` | `string` | Human-readable delay (e.g. `"16s"`, `"2m 8s"`) |
| `cumulativeWaitMs` | `number` | Total time spent waiting across all retries for this turn+step |

---

## UI visual indicator

The plugin provides two mechanisms for building retry status UIs:

### 1. Live retry state accessor

Use `ctx.retryState()` to get the current retry state at any time. This is ideal for reactive UIs that poll or subscribe to state changes.

```javascript
// In any component or event handler:
const state = ctx.retryState();

if (state.active) {
  console.log(state.statusMessage);
  // → "Retrying — rate limited (429), attempt #3, waiting 16s"

  console.log(`${state.remainingFormatted} remaining`);
  // → "12s remaining"

  // state includes: active, retry, statusCode, statusText, delayMs,
  // deadline, remainingMs, remainingFormatted, cumulativeWaitMs, etc.
}
```

The `remainingMs` and `remainingFormatted` fields are **computed on read** — they reflect the live countdown as the wait progresses.

### 2. Display helpers (`dsh-llm-retry-infinite/display`)

Import from the `/display` subpath for rendering utilities:

```javascript
import {
  renderTerminalStatus,
  renderHTMLIndicator,
  renderMarkdownStatus,
  statusIndicator,
  RETRY_INDICATOR_CSS,
} from "dsh-llm-retry-infinite/display";
```

#### Terminal status

```javascript
const state = ctx.retryState();
const line = renderTerminalStatus(state);
// → "⏳ Retrying #3 — rate limited (429), waiting 16s (4s remaining)"
```

#### HTML indicator

```javascript
const state = ctx.retryState();
const html = renderHTMLIndicator(state);
// Returns a self-contained <div> with classes for CSS styling.
// Inject RETRY_INDICATOR_CSS for default styling.
```

#### Markdown status

```javascript
const state = ctx.retryState();
const md = renderMarkdownStatus(state);
// → "⏳ **Retrying #3** — rate limited `429` · waiting 16s · 4s left"
```

#### Status indicator lookup

```javascript
const info = statusIndicator(429);
// → { color: "yellow", emoji: "⏳", label: "Rate Limited" }
```

### Status code visual mapping

| Code | Emoji | Color | Label |
|------|-------|-------|-------|
| 429 | ⏳ | yellow | Rate Limited |
| 500 | 💥 | red | Server Error |
| 502 | 🔴 | red | Bad Gateway |
| 503 | 🔴 | red | Service Unavailable |
| 408 | ⏱️ | orange | Timeout |
| 401 | 🔒 | red | Unauthorized |
| 403 | 🚫 | red | Forbidden |
| other | ❓ | gray | Unknown Error |

---

## How it differs from the built-in `dsh-llm-retry`

| | `dsh-llm-retry-infinite` | `@deepseek-ai/dsh-llm-retry` |
|---|---|---|
| **Retry limit** | ∞ (none) | 2 (default), configurable |
| **Scope** | Global — all providers | Per-provider via `retryPolicy` |
| **Configuration** | Plugin-level in `cordis.patch.yml` | Each provider adapter's `retryPolicy` field |
| **Modes** | Always retries | `normal` (bounded) or `always` (unbounded) |
| **Replaces built-in?** | Yes — disables it via patch | N/A (is the built-in) |
| **Backoff** | Exponential, 10 min cap | Exponential, 10 s default cap |

---

## Architecture notes

### Why disable the built-in?

DSH loads bundles in order. `dsh-base` (which contains `dsh-llm-retry`) is always first. In Cordis's waterfall event dispatch, handlers run **outermost-first** — the first-registered handler intercepts before later ones. If the built-in is not disabled, it handles the first 2 retries with its own backoff, then exhausts and passes control downstream. Disabling it via `cordis.patch.yml` ensures our plugin is the only handler.

### Plugin structure

```
dsh-llm-retry-infinite/
├── cordis.patch.yml        # Auto-insert entry for the Cordis loader
├── lib/
│   ├── index.js            # Plugin implementation
│   └── types/
│       └── index.d.ts      # TypeScript declarations
├── package.json            # dsh.bundle declaration + schemastery dep
└── README.md
```

The `dsh.bundle.patch` field in `package.json` points to `cordis.patch.yml`, which tells the loader how to insert the plugin into the layer stack.

---

## License

MIT
