/**
 * dsh-llm-retry-infinite display helpers
 *
 * Utilities for rendering retry status in UI contexts.
 *
 * @module dsh-llm-retry-infinite/display
 */
import type { RetryState } from "./index";

/**
 * HTTP status code to visual indicator mapping.
 */
export interface StatusIndicator {
  color: string;
  emoji: string;
  label: string;
}

/**
 * Get the visual indicator (color, emoji, label) for an HTTP status code.
 *
 * @param statusCode - HTTP status code (e.g. 429, 500)
 * @returns Visual indicator with color, emoji, and human-readable label
 */
export declare function statusIndicator(statusCode: number | undefined): StatusIndicator;

/**
 * Render a compact terminal-friendly retry status line.
 *
 * @example
 *   "⏳ Retrying #3 — rate limited (429), waiting 16s (4s remaining)"
 *
 * @param state - Current retry state from ctx.retryState()
 * @returns Formatted string, or empty string if not retrying
 */
export declare function renderTerminalStatus(state: RetryState): string;

/**
 * Render an HTML snippet for the retry indicator.
 * Designed to be injected into DSH web panels or custom UI containers.
 *
 * @param state - Current retry state from ctx.retryState()
 * @returns HTML string, or empty string if not retrying
 */
export declare function renderHTMLIndicator(state: RetryState): string;

/**
 * Render a minimal markdown status line (for chat/command contexts).
 *
 * @param state - Current retry state from ctx.retryState()
 * @returns Markdown string, or empty string if not retrying
 */
export declare function renderMarkdownStatus(state: RetryState): string;

/**
 * CSS styles for the HTML indicator.
 * Can be injected via a `<style>` tag when using renderHTMLIndicator().
 */
export declare const RETRY_INDICATOR_CSS: string;

/**
 * Format a delay in milliseconds to a human-readable string.
 *
 * @param ms - Delay in milliseconds
 * @returns Formatted string (e.g. "16s", "2m 8s")
 */
export declare function formatDelay(ms: number): string;
