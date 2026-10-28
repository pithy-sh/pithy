// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import type { ConsentPurpose } from "./purpose";

/**
 * The consent seam: the one question a capability asks before consent-based processing.
 *
 * `@pithy-sh/consent` answers it, and nothing imports that package to ask: a capability finds the composed reader
 * through {@link composedConsent}, the shape `composedAuditEmit` gives the audit recorder, so `@pithy-sh/email`
 * gates its tracking without depending on a sibling (principle 4).
 *
 * **Absent is not "no".** With no consent capability composed there is no record to consult, so
 * {@link composedConsent} answers `null`, and a capability gates nothing on it. `pithy doctor`
 * names that state, because processing that a law may require consent for is running with no record behind it.
 */

/** The subject a consent is recorded against: an account's user id, or a visitor's anonymous device id. */
export interface ConsentSubject {
  /** `account` — a user id from `@pithy-sh/auth`; `visitor` — an anonymous device id held in a first-party cookie. */
  readonly kind: "account" | "visitor";
  /** The id in that kind. */
  readonly id: string;
}

/** What the consent capability answers. */
export interface ConsentReader {
  /**
   * Whether `subject` holds consent to `purpose` now: a grant under the purpose's current notice version, at or
   * above its minimum method, not withdrawn since, and not expired. An account's answer includes what the visitors
   * merged into it granted. A purpose the catalog does not know answers no.
   */
  hasConsent(subject: ConsentSubject, purpose: string): Promise<boolean>;
  /**
   * Every purpose in the composed catalog, the adopter's included, with how many subjects stand where on it now. What
   * the processing record cites for a consent-based activity. Optional on the seam: a reader without it leaves the
   * counts unknown, never zero.
   */
  standings?(): Promise<readonly ConsentPurposeStanding[]>;
  /**
   * Every purpose in the composed catalog, the adopter's included, read from memory and never from the record. What
   * the processing record checks a consent basis against when `standings` cannot answer. Optional on the seam: a
   * reader without it leaves the catalog unknown, and the record then reports no gap that rests on the catalog.
   */
  purposes?(): readonly ConsentPurpose[];
}

/** One purpose in the catalog, and where its subjects stand on it now. */
export interface ConsentPurposeStanding {
  /** The purpose as the catalog composed it. */
  readonly purpose: ConsentPurpose;
  /** Subjects whose latest choice is a grant, under any notice version, expired or not. */
  readonly grants: number;
  /** Subjects whose latest choice is a withdrawal. */
  readonly withdrawals: number;
  /**
   * Subjects `hasConsent` answers yes for now: a grant under the current notice version, at or above the purpose's
   * minimum method, unexpired, and for a visitor not merged into an account, inside the visitor window.
   */
  readonly standing: number;
}

/** One withdrawal, as a capability that keeps its own state in step with consent is told of it. */
export interface ConsentWithdrawal {
  /** Who withdrew. */
  readonly subject: ConsentSubject;
  /** What they withdrew from. */
  readonly purpose: string;
  /** The Worker's bindings for this request. */
  readonly env: Record<string, unknown>;
  /**
   * The subject's email address, read on demand from the capability that owns accounts, or `null` for a visitor
   * or an account with none. A function, so a listener that needs no address reads none.
   */
  readonly address: () => Promise<string | null>;
}

/**
 * Hear of a withdrawal from one of this capability's own purposes. `@pithy-sh/email` suppresses the address for
 * marketing when `email.marketing` is withdrawn, so the suppression list and the consent record never disagree.
 * Called after the withdrawal is recorded; a throw is the listener's own failure and never undoes the record.
 */
export type ConsentWithdrawnListener = (withdrawal: ConsentWithdrawal) => Promise<void>;

/** One grant that now stands, as a capability that keeps its own state in step with consent is told of it. */
export type ConsentGrant = ConsentWithdrawal;

/**
 * Hear of a grant to one of this capability's own purposes, once it stands. The other half of
 * {@link ConsentWithdrawnListener}: `@pithy-sh/email` lifts the marketing suppression a withdrawal wrote when
 * `email.marketing` is granted again, and nothing else, so a person who changes their mind back is heard. Called
 * after the grant is recorded and only when the subject's standing is `granted`; a throw never undoes the record.
 */
export type ConsentGrantedListener = (grant: ConsentGrant) => Promise<void>;

/** Every purpose the composed capabilities declare, in composition order. */
export function composedConsentPurposes(capabilities: readonly Capability[]): ConsentPurpose[] {
  return capabilities.flatMap((capability) => [...(capability.consentPurposes ?? [])]);
}

/** The composed consent reader for this env, or `null` when no capability provides one. */
export function composedConsent(
  capabilities: readonly Capability[],
  env: Record<string, unknown>,
): ConsentReader | null {
  const provider = capabilities.find((capability) => capability.consentReader !== undefined);
  return provider?.consentReader ? provider.consentReader(env) : null;
}

/** Whether any composed capability provides the consent seam. */
export function providesConsent(capabilities: readonly Capability[]): boolean {
  return capabilities.some((capability) => capability.consentReader !== undefined);
}

/**
 * The account's address, read through the capability that owns accounts (`@pithy-sh/auth`'s `addressOf`), or
 * `null` where nothing composed can say. Never throws: a listener that cannot learn the address does less, and the
 * withdrawal it heard of stands.
 */
export async function composedAddress(
  capabilities: readonly Capability[],
  env: Record<string, unknown>,
  subject: ConsentSubject,
): Promise<string | null> {
  if (subject.kind !== "account") return null;
  const provider = capabilities.find((capability) => capability.addressOf !== undefined);
  if (!provider?.addressOf) return null;
  try {
    return await provider.addressOf(env, subject.id);
  } catch {
    return null;
  }
}
