# `dsh-llm-retry-infinite`

DSH plugin that applies **infinite exponential retries** to every LLM request failure, with each individual wait period capped at **10 minutes**.

## How it works

1. Listens on the `agent/request-error` event from the DSH agent loop.
2. On failure, computes an exponential backoff delay: `min(initialDelayMs × 2^retry, maxDelayMs)`.
3. Waits the computed delay (with symmetric jitter, cancellable on abort).
4. Returns `{ kind: 'retry' }` to re-attempt the request.
5. Repeats **indefinitely** until the request succeeds, the session is cancelled, or the plugin is disposed.

There is **no retry limit** — retries continue forever, making this suitable for environments with transient rate limits or unreliable connectivity where you want the harness to keep trying.

## Backoff schedule

| Retry | Delay (default config) |
|-------|----------------------|
| 1     | ~1 s  (1000 × 2⁰)   |
| 2     | ~2 s  (1000 × 2¹)   |
| 3     | ~4 s  (1000 × 2²)   |
| 4     | ~8 s  (1000 × 2³)   |
| 5     | ~16 s (1000 × 2⁴)   |
| 6     | ~32 s (1000 × 2⁵)   |
| 7     | ~64 s (1000 × 2⁶)   |
| 8     | ~128 s (1000 × 2⁷)  |
| 9     | ~256 s (1000 × 2⁸)  |
| 10    | ~512 s (1000 × 2⁹)  |
| 11+   | **600 s (10 min cap)** |

Each delay includes ±10 % symmetric jitter by default.

## Installation

```bash
cd ~/.dsh/profiles/<your-profile>
pnpm add dsh-llm-retry-infinite
```

Then add to your profile's bundle list in `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-llm-retry-infinite"
      ]
    }
  }
}
```

## Configuration

All config fields are optional. Defaults are shown in parentheses.

```yaml
# In cordis.patch.yml
- name: dsh-llm-retry-infinite
  config:
    initialDelayMs: 1000   # Base delay for first retry (default: 1000)
    maxDelayMs: 600000     # Cap per wait period — 10 min (default: 600000)
    jitterRatio: 0.1       # Symmetric jitter ±10% (default: 0.1)
```

### Constraints

- `initialDelayMs` must be positive and ≤ 600 000.
- `maxDelayMs` must be positive and ≤ 600 000.
- `jitterRatio` must be in [0, 1].
- `initialDelayMs` must be ≤ `maxDelayMs`.

The hard ceiling of 600 000 ms (10 minutes) cannot be overridden.

## How it differs from `@deepseek-ai/dsh-llm-retry`

| Feature | `dsh-llm-retry-infinite` | `@deepseek-ai/dsh-llm-retry` |
|---------|--------------------------|-------------------------------|
| Retry limit | **None** (infinite) | Configurable (default: 2) |
| Scope | Global for all providers | Per-provider via `retryPolicy` config |
| Configuration | Plugin-level config | Provider adapter `retryPolicy` field |
| Modes | Always retries | `normal` (bounded) or `always` (unbounded) |

If you need per-provider control, use `@deepseek-ai/dsh-llm-retry` with `mode: 'always'` on each adapter. This plugin is a simpler global override.

## Session events

The plugin emits two durable (non-surface) session events:

- **`llm/retry-infinite`** — recorded before each wait, with `turn`, `step`, `provider`, `retry` number, `delayMs`, and `failure` details.
- **`llm/retry-infinite-started`** — recorded when the wait completes and the retry begins.

These are not visible to the model and do not contribute to token billing.

## License

MIT
# dsh-llm-retry-infinite
