/**
 * dsh-llm-retry-infinite display helpers
 *
 * Utilities for rendering retry status in UI contexts (terminal, web, logging).
 *
 * @module dsh-llm-retry-infinite/display
 */

/**
 * HTTP status code to color/emoji mapping for visual indicators.
 */
const STATUS_COLORS = {
  429: { color: "yellow", emoji: "⏳", label: "Rate Limited" },
  503: { color: "red", emoji: "🔴", label: "Service Unavailable" },
  502: { color: "red", emoji: "🔴", label: "Bad Gateway" },
  500: { color: "red", emoji: "💥", label: "Server Error" },
  408: { color: "orange", emoji: "⏱️", label: "Timeout" },
  401: { color: "red", emoji: "🔒", label: "Unauthorized" },
  403: { color: "red", emoji: "🚫", label: "Forbidden" },
  default: { color: "gray", emoji: "❓", label: "Unknown Error" },
};

/**
 * Get the visual indicator for a status code.
 *
 * @param {number|undefined} statusCode
 * @returns {{ color: string, emoji: string, label: string }}
 */
export function statusIndicator(statusCode) {
  if (statusCode === undefined) return STATUS_COLORS.default;
  return STATUS_COLORS[statusCode] ?? STATUS_COLORS.default;
}

/**
 * Render a compact terminal-friendly retry status line.
 *
 * Example output:
 *   ⏳ Retrying #3 — rate limited (429), waiting 16s (4s remaining)
 *
 * @param {import('../index.js').RetryState} state
 * @returns {string}
 */
export function renderTerminalStatus(state) {
  if (!state.active) return "";
  const { emoji, label } = statusIndicator(state.statusCode);
  const codeStr = state.statusCode ? ` (${state.statusCode})` : "";
  const remaining = state.remainingFormatted ?? "0s";
  return `${emoji} Retrying #${state.retry} — ${label}${codeStr}, waiting ${state.delayFormatted} (${remaining} remaining)`;
}

/**
 * Render an HTML snippet for the retry indicator.
 * Designed to be injected into DSH web panels or custom UI containers.
 *
 * @param {import('../index.js').RetryState} state
 * @returns {string} HTML string
 */
export function renderHTMLIndicator(state) {
  if (!state.active) return "";

  const { color, emoji, label } = statusIndicator(state.statusCode);
  const codeStr = state.statusCode
    ? `<span class="retry-status-code">${state.statusCode}</span>`
    : "";
  const remaining = state.remainingFormatted ?? "0s";

  return `
<div class="dsh-retry-indicator" data-retry="${state.retry}" data-status="${state.statusCode ?? ""}">
  <div class="retry-indicator-header">
    <span class="retry-emoji">${emoji}</span>
    <span class="retry-label">${label}</span>
    ${codeStr}
  </div>
  <div class="retry-indicator-body">
    <div class="retry-attempt">
      Attempt <strong>#${state.retry}</strong>
      ${state.provider ? ` · ${state.provider}` : ""}
    </div>
    <div class="retry-countdown">
      <div class="retry-countdown-bar">
        <div class="retry-countdown-fill" style="--retry-progress: ${(state.remainingMs / state.delayMs) * 100}%"></div>
      </div>
      <span class="retry-countdown-text">${remaining} remaining</span>
    </div>
    <div class="retry-cumulative">
      Total wait: ${formatDelay(state.cumulativeWaitMs)}
    </div>
  </div>
</div>`.trim();
}

/**
 * Render a minimal markdown status line (for chat/command contexts).
 *
 * @param {import('../index.js').RetryState} state
 * @returns {string}
 */
export function renderMarkdownStatus(state) {
  if (!state.active) return "";
  const { emoji, label } = statusIndicator(state.statusCode);
  const codeStr = state.statusCode ? ` \`${state.statusCode}\`` : "";
  const remaining = state.remainingFormatted ?? "0s";
  return `${emoji} **Retrying #${state.retry}** — ${label}${codeStr} · waiting ${state.delayFormatted} · ${remaining} left`;
}

/**
 * Format delay in ms to human-readable string.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDelay(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * CSS styles for the HTML indicator. Can be injected via a <style> tag.
 */
export const RETRY_INDICATOR_CSS = `
.dsh-retry-indicator {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 8px 0;
  background: #fafafa;
  max-width: 400px;
}

.dsh-retry-indicator[data-status="429"] {
  border-color: #f59e0b;
  background: #fffbeb;
}

.dsh-retry-indicator[data-status^="5"] {
  border-color: #ef4444;
  background: #fef2f2;
}

.retry-indicator-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}

.retry-emoji {
  font-size: 18px;
}

.retry-status-code {
  font-family: "SF Mono", SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.08);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.retry-indicator-body {
  font-size: 13px;
  color: #374151;
}

.retry-attempt {
  margin-bottom: 8px;
}

.retry-countdown {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.retry-countdown-bar {
  flex: 1;
  height: 4px;
  background: #e5e7eb;
  border-radius: 2px;
  overflow: hidden;
}

.retry-countdown-fill {
  height: 100%;
  width: var(--retry-progress, 100%);
  background: #3b82f6;
  border-radius: 2px;
  transition: width 1s linear;
}

.retry-countdown-text {
  font-size: 12px;
  color: #6b7280;
  white-space: nowrap;
}

.retry-cumulative {
  font-size: 12px;
  color: #9ca3af;
}
`.trim();

export { formatDelay };
