/**
 * dsh-llm-retry-infinite web client plugin
 *
 * Provides a live visual retry status indicator docked above the composer
 * in the DSH Web UI.
 *
 * @module dsh-llm-retry-infinite/client
 */

const RETRY_DOCK_CSS = `
.dsh-retry-dock-card {
  box-sizing: border-box;
  width: 100%;
  max-width: 780px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 10px;
  padding: 10px 14px;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 8px;
  background: var(--dsw-alias-bg-module-platform, #fafafa);
  color: var(--dsw-alias-label-primary, #111827);
  font-family: inherit;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  animation: dsh-retry-slide-in 0.2s ease-out;
}
.dsh-retry-dock-card[data-status="429"] {
  border-color: rgba(245, 158, 11, 0.45);
  background: var(--dsw-alias-bg-layer-1, #fffbeb);
}
.dsh-retry-dock-card[data-status^="5"] {
  border-color: rgba(239, 68, 68, 0.45);
  background: var(--dsw-alias-bg-layer-1, #fef2f2);
}
.dsh-retry-dock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-retry-dock-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}
.dsh-retry-dock-emoji {
  font-size: 14px;
}
.dsh-retry-dock-badge {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.07);
  font-weight: 500;
}
.dsh-retry-dock-attempt {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.dsh-retry-dock-progress-track {
  height: 4px;
  background: var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 2px;
  overflow: hidden;
}
.dsh-retry-dock-progress-bar {
  height: 100%;
  background: var(--dsw-alias-brand-primary, #3b82f6);
  border-radius: 2px;
  transition: width 0.2s linear;
}
.dsh-retry-dock-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.dsh-retry-dock-error {
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.dsh-retry-dock-time {
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #111827);
  white-space: nowrap;
}
@keyframes dsh-retry-slide-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
`;

const STATUS_INDICATORS = {
  429: { color: "yellow", emoji: "⏳", label: "Rate Limited" },
  503: { color: "red", emoji: "🔴", label: "Service Unavailable" },
  502: { color: "red", emoji: "🔴", label: "Bad Gateway" },
  500: { color: "red", emoji: "💥", label: "Server Error" },
  408: { color: "orange", emoji: "⏱️", label: "Timeout" },
  401: { color: "red", emoji: "🔒", label: "Unauthorized" },
  403: { color: "red", emoji: "🚫", label: "Forbidden" },
  default: { color: "gray", emoji: "🔄", label: "Retrying LLM Request" },
};

function statusIndicator(statusCode) {
  if (statusCode === undefined || statusCode === null) return STATUS_INDICATORS.default;
  return STATUS_INDICATORS[statusCode] ?? STATUS_INDICATORS.default;
}

function formatDelay(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  const tagId = "dsh-llm-retry-infinite/dock.css";
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-llm-retry-infinite";
  tag.dataset.pluginCss = tagId;
  tag.textContent = RETRY_DOCK_CSS;
  document.head.appendChild(tag);
}

/**
 * React dock component rendered above the message composer.
 * Displays active retry status, live progress bar, attempt number, status code badge, and time left.
 */
function createRetryDock(React) {
  const { createElement: h, useState, useEffect, useMemo } = React;

  return function RetryDock(props) {
    ensureStyles();

    const session = props.session;
    const nodes = session?.chat?.nodes?.values
      ? session.chat.nodes.values()
      : (session?.nodes ?? []);

    const retryNodes = nodes.filter((n) => n && (n.kind === "model-retry" || n.type === "model-retry"));
    const retryNode = retryNodes.at(-1);
    const current = retryNode?.data?.current ?? retryNode;

    const active = Boolean(
      current &&
      current.retryState === "scheduled" &&
      session?.running !== false
    );

    const delayMs = current?.delayMs || 1000;
    const seq = current?.seq ?? 0;
    const failure = current?.failure;
    const statusCode = failure?.status ?? current?.statusCode;
    const retry = current?.retry || 1;
    const provider = current?.provider || "";
    const failureMsg = typeof failure === "string" ? failure : (failure?.message || "LLM request failed");

    const [now, setNow] = useState(() => Date.now());

    const deadline = useMemo(() => {
      return Date.now() + delayMs;
    }, [delayMs, seq]);

    useEffect(() => {
      if (!active) return;
      setNow(Date.now());
      const timer = setInterval(() => {
        setNow(Date.now());
      }, 200);
      return () => clearInterval(timer);
    }, [active, deadline]);

    if (!active) return null;

    const remainingMs = Math.max(0, deadline - now);
    const remainingFormatted = formatDelay(remainingMs);
    const delayFormatted = formatDelay(delayMs);
    const progressPct = delayMs > 0
      ? Math.min(100, Math.max(0, ((delayMs - remainingMs) / delayMs) * 100))
      : 100;
    const indicator = statusIndicator(statusCode);

    return h("div", {
      className: "dsh-retry-dock-card",
      "data-status": statusCode ? String(statusCode) : "default",
      role: "status",
      "aria-live": "polite",
    }, [
      h("div", { className: "dsh-retry-dock-header", key: "header" }, [
        h("div", { className: "dsh-retry-dock-status" }, [
          h("span", { className: "dsh-retry-dock-emoji" }, indicator.emoji),
          h("span", null, indicator.label),
          statusCode ? h("span", { className: "dsh-retry-dock-badge" }, String(statusCode)) : null,
        ]),
        h("div", { className: "dsh-retry-dock-attempt" }, [
          `Attempt #${retry} · ∞ retries`,
          provider ? ` · ${provider}` : "",
        ]),
      ]),
      h("div", { className: "dsh-retry-dock-progress-track", key: "progress" }, [
        h("div", {
          className: "dsh-retry-dock-progress-bar",
          style: { width: `${progressPct}%` },
        }),
      ]),
      h("div", { className: "dsh-retry-dock-footer", key: "footer" }, [
        h("span", { className: "dsh-retry-dock-error", title: failureMsg }, failureMsg),
        h("span", { className: "dsh-retry-dock-time" }, `${remainingFormatted} remaining (${delayFormatted})`),
      ]),
    ]);
  };
}

let DefaultRetryDock = null;
if (typeof require !== "undefined") {
  try {
    const React = require("react");
    DefaultRetryDock = createRetryDock(React);
  } catch (_e) {}
}

const inject = ["slots", "conversation"];

function apply(ctx) {
  if (ctx.slots && typeof ctx.slots.inject === "function") {
    ctx.slots.inject("conversation.input.dock", () => {
      let React = null;
      try {
        React = (typeof require !== "undefined" && require("react")) || globalThis.React;
      } catch (_e) {}
      const Component = React ? createRetryDock(React) : DefaultRetryDock;
      return ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "dsh-llm-retry-infinite-dock",
          order: 1,
        },
        Component
      );
    });
  }
}

function _buildClientModule(require) {
  const module = { exports: {} };
  const exports = module.exports;
  const React = require("react");
  const RetryDockComponent = createRetryDock(React);

  function clientApply(ctx) {
    if (ctx.slots && typeof ctx.slots.inject === "function") {
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "dsh-llm-retry-infinite-dock",
            order: 1,
          },
          RetryDockComponent
        )
      );
    }
  }

  exports.apply = clientApply;
  exports.inject = inject;
  exports.RetryDock = RetryDockComponent;
  return module.exports;
}

if (typeof window !== "undefined") {
  const loader = window.__ModuleLoader__;
  if (loader && typeof loader.load === "function") {
    try {
      loader.load({
        id: "dsh-llm-retry-infinite",
        factory: _buildClientModule,
      });
    } catch (_e) {
      queueMicrotask(_register);
    }
  } else {
    queueMicrotask(_register);
  }
}

function _register() {
  if (typeof window === "undefined") return;
  const loader = window.__ModuleLoader__;
  if (loader && typeof loader.load === "function") {
    loader.load({
      id: "dsh-llm-retry-infinite",
      factory: _buildClientModule,
    });
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = _buildClientModule;
  module.exports.apply = apply;
  module.exports.inject = inject;
  module.exports.createRetryDock = createRetryDock;
  module.exports.DefaultRetryDock = DefaultRetryDock;
}