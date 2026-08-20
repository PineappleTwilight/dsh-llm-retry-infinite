/**
 * dsh-llm-retry-infinite web client plugin
 *
 * Provides a live visual retry status indicator docked above the composer
 * in the DSH Web UI.
 *
 * @module dsh-llm-retry-infinite/client
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";

export declare const inject: string[];
export declare function apply(ctx: Context): void;
export declare function createRetryDock(React: any): (props: any) => ReactNode;
export declare const RetryDock: ((props: any) => ReactNode) | null;
