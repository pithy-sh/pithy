// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SupportConfig } from "../config/config";

/** The placeholder `reply.fromName` writes the answering agent's name into. */
export const AGENT_PLACEHOLDER = "{agent}";

/**
 * The display name a reply is sent under: `reply.fromName` with the agent's name written in.
 *
 * A pattern with no placeholder is a fixed name, used whoever answered. A pattern with one is undefined when no
 * agent name is given, so the email capability's own `fromName` is used. Line breaks and control characters are
 * folded to spaces, because the result is a header value.
 */
export function replyFromName(pattern: string, agentName: string | undefined): string | undefined {
  const agent = agentName?.trim() ?? "";
  if (pattern.includes(AGENT_PLACEHOLDER) && !agent) return undefined;
  const name = pattern
    .split(AGENT_PLACEHOLDER)
    .join(agent)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return name === "" ? undefined : name;
}

/**
 * Every address support may send a reply as: its `inboundAddresses` and `reply.replyToAddress`, normalized and
 * once each. `compose` binds the email capability's `enqueueAs` to exactly these, so a reply cannot be sent as
 * an address this inbox does not claim.
 */
export function claimedSenders(config: SupportConfig): string[] {
  const addresses = [...config.inboundAddresses, ...(config.reply.replyToAddress ? [config.reply.replyToAddress] : [])];
  return [...new Set(addresses)];
}
