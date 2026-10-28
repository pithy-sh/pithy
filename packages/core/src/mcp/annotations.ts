// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ScopeKind } from "../controlPlane/scope/kind";

/**
 * What an MCP tool says about itself, from the kind of thing it does. One mapping for both servers: the app's own
 * tools, whose effect is a kind without `reads` or `credentials`, and the control-plane tools `pithy mcp serve`
 * offers, whose route declares its scope's kind.
 */

/** The MCP annotations a tool carries, set by its kind. `idempotentHint` is claimed for a read and nothing else. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint?: true;
  readonly openWorldHint: boolean;
}

/** What each kind says in a tool's description, and on the consent screen. One sentence each. */
export const KIND_SENTENCES: Readonly<Record<ScopeKind, string>> = {
  reads: "Reads data and changes nothing.",
  writes: "Changes data in this application.",
  sends: "Sends a message to somebody.",
  charges: "Charges money.",
  deletes: "Deletes data, and it cannot be undone.",
  credentials: "Mints, rotates or revokes a credential.",
};

/** The MCP annotations for a kind. */
export function kindAnnotations(kind: ScopeKind): ToolAnnotations {
  return {
    readOnlyHint: kind === "reads",
    destructiveHint: kind === "charges" || kind === "deletes" || kind === "credentials",
    ...(kind === "reads" ? { idempotentHint: true as const } : {}),
    openWorldHint: kind === "sends" || kind === "charges",
  };
}
