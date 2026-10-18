// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import type { Logger } from "../logger/logger";

/**
 * The usage-meter seam — how a capability that writes the rows a meter counts asks whether one more is
 * allowed, when there is no request to ask through.
 *
 * `@pithy-sh/email` enqueues from a route, from a Workflow step and from a cron, and only the first has a
 * `c.var.entitlements`. So the meter it charges is found the way the ledger is found — among the composed
 * capabilities, by a structural predicate — and it is handed the holder explicitly. Nothing here imports the
 * provider: an email capability composed with no payments finds no meter and enqueues as it always did.
 *
 * **A meter refuses; it never bills.** `charge` either records the use or throws the provider's own refusal
 * (`payments/quota_exceeded`, 402). What it counted is never reported to a store — the kit does not sell
 * overage — so this seam has no way to read a count back out.
 */

/** Who a charge is against: the holder pair, exactly as the provider keys it. */
export interface MeterSubject {
  /** The kind of holder — `user` or `organization` under `@pithy-sh/payments`. */
  readonly subjectType: string;
  /** The holder's id. */
  readonly subjectId: string;
}

/** One charge against one meter. */
export interface MeterCharge {
  /** Who uses it. */
  readonly subject: MeterSubject;
  /** Which meter — `emails`. */
  readonly meter: string;
  /** How many. A whole number from 1. */
  readonly amount: number;
  /** The clock. Defaults to now. */
  readonly now?: Date;
  /** Where a refused or failed charge is logged. Optional; the provider logs through its own when absent. */
  readonly log?: Logger;
}

/** The meter a provider exposes. */
export interface UsageMeter {
  /** The capability answering — `payments`. */
  readonly provider: string;
  /**
   * Record `amount` of `meter` against `subject`, or refuse. An advisory meter records nothing and refuses
   * nothing. **A charge that cannot be checked refuses**, because under-counting has no recovery.
   */
  charge(env: Record<string, unknown>, charge: MeterCharge): Promise<void>;
}

/** A composed capability that provides a meter. */
export interface UsageMeterProvider extends Capability {
  /** The meter. */
  readonly usageMeter: UsageMeter;
}

/** Whether a composed capability provides a usage meter. Structural, so no provider package is imported. */
export function isUsageMeterProvider(capability: Capability): capability is UsageMeterProvider {
  const meter = (capability as { usageMeter?: { charge?: unknown } }).usageMeter;
  return typeof meter?.charge === "function";
}

/** The composed usage meter, or undefined when nothing composed provides one. */
export function composedUsageMeter(capabilities: readonly Capability[]): UsageMeter | undefined {
  return capabilities.find(isUsageMeterProvider)?.usageMeter;
}
