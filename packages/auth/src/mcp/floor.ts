// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Who the MCP endpoint admits at all (`docs/AGENT-ACCESS.md` §4).
 *
 * **The default is closed.** Correct route gates are not the whole question: an endpoint that lets any signed-in
 * user drive an agent against the application is remote automation of a surface built for a person at a keyboard,
 * which changes rate, cost and abuse patterns even when every gate holds. So the capability is off unless composed,
 * and composing it means choosing one of three floors — there is no default to fall into:
 *
 * - `{ power }` — a caller whose role in the acting organization holds this power.
 * - `{ entitlement }` — a caller holding this entitlement, a tier floor.
 * - `"signed-in"` — every signed-in user. A decision, stated in config, and `pithy doctor` says it out loud.
 *
 * The floor is the endpoint's, not a tool's. Above it, every tool is still gated by its own route.
 */
export const McpFloor = z
  .union([
    z.literal("signed-in").describe("Every signed-in user may connect an agent. `pithy doctor` reports it as open."),
    z
      .object({ power: z.string().min(1).describe("The power a caller's role must hold, e.g. `agents:use`.") })
      .strict()
      .describe("Only a caller whose role holds this power."),
    z
      .object({ entitlement: z.string().min(1).describe("The entitlement a caller must hold, e.g. `pro`.") })
      .strict()
      .describe("Only a caller holding this entitlement."),
  ])
  .describe(
    "Who the MCP endpoint admits at all. Required: a power, an entitlement, or `signed-in` for every signed-in user. Every tool is still gated by its own route above it.",
  );
export type McpFloor = z.infer<typeof McpFloor>;

/** What a caller holds, for {@link floorAdmits}. */
export interface FloorCaller {
  /** Whether the caller's role holds a power, or `null` when no organization is in force. */
  readonly roleAllows: ((power: string) => boolean) | null;
  /** The entitlement keys the caller holds and that grant access now. */
  readonly entitlements: () => Promise<ReadonlySet<string>>;
}

/** Whether the floor admits this signed-in caller. */
export async function floorAdmits(floor: McpFloor, caller: FloorCaller): Promise<boolean> {
  if (floor === "signed-in") return true;
  if ("power" in floor) return caller.roleAllows?.(floor.power) ?? false;
  return (await caller.entitlements()).has(floor.entitlement);
}

/** Whether the endpoint is open to every signed-in user. What `pithy doctor` reports. */
export function isOpenToEverySignedInUser(floor: McpFloor): boolean {
  return floor === "signed-in";
}

/** The floor in one line, for `pithy doctor` and the manifest. */
export function floorLine(floor: McpFloor): string {
  if (floor === "signed-in") return "open to every signed-in user";
  if ("power" in floor) return `open only to callers whose role holds ${floor.power}`;
  return `open only to callers holding the ${floor.entitlement} entitlement`;
}
