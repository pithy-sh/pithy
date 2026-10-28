// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The one place an MCP tool name is made (`docs/AGENT-ACCESS.md` §5) — for the control-plane server's tools, and
 * for the app's own MCP endpoint's (`../../mcp/tools.ts`), so one rule names both servers' tools.
 *
 * **Derived, never hand-written.** A tool is `<capability>_<operation>`: the capability's name, which already
 * partitions migrations, tables and error codes, and the operation the capability declared beside the route. Two
 * capabilities both exposing `threads.list` cannot collide, and nothing about the route's path or scope — both of
 * which move or are shared — reaches the name.
 *
 * **Neither existing separator survives.** MCP names conventionally allow `[a-z0-9_-]`, so a scope's `:`, an
 * audit action's `/` and an operation's `.` all become `_`. Anything else outside that alphabet does too, so a
 * name is always one a client accepts — but a kit operation never needs it, and `AdminOperation` refuses one that
 * would.
 *
 * **Once published, a tool name is permanent.** An agent references it in prompts and saved workflows, so this
 * function's output for a given pair must never change. `toolName.test.ts` pins it.
 */
export function controlPlaneToolName(capability: string, operation: string): string {
  return `${capability}_${operation}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}
