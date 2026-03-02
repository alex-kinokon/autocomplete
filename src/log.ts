/**
 * Logging to the "Autocomplete" output channel.
 *
 * - `info` / `warn` / `error`: always emitted.
 * - `debug`: only emitted when `autocomplete.debug` is enabled in settings.
 */
import * as vscode from "vscode";

import { getSetting } from "./config.ts";

let channel: vscode.OutputChannel | undefined;

/** Create the output channel. Call once during activation. */
export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("Autocomplete");
  context.subscriptions.push(channel);
}

function write(level: string, message: string, ...args: unknown[]): void {
  if (!channel) return;
  const timestamp = new Date().toISOString().slice(11, 23);
  const suffix =
    args.length > 0
      ? " " +
        args.map(a => (a instanceof Error ? a.message : JSON.stringify(a))).join(" ")
      : "";
  channel.appendLine(`[${timestamp}] ${level} ${message}${suffix}`);
}

/** Verbose logging gated by the `autocomplete.debug` setting. */
export function debug(message: string, ...args: unknown[]): void {
  if (!getSetting("debug")) {
    return;
  }
  write("DEBUG", message, ...args);
}

export function info(message: string, ...args: unknown[]): void {
  write("INFO", message, ...args);
}

export function warn(message: string, ...args: unknown[]): void {
  write("WARN", message, ...args);
}

export function error(message: string, ...args: unknown[]): void {
  write("ERROR", message, ...args);
}
