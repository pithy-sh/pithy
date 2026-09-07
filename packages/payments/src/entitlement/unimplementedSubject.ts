// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { PaymentsSubjectResolver } from "./subjectSeam";

/**
 * The placeholder `pithy add payments --set billingSubject=organization` scaffolds, and the brand that
 * makes it recognizably unfinished.
 *
 * ## Why a placeholder is safe here and a stub never is
 *
 * A stub is a resolver that *answers*. Returning `undefined` composes cleanly, satisfies every check the
 * capability can make, and then denies every entitlement gate and raises `payments/subject_unresolved` on
 * every write — which is indistinguishable from a customer who has not paid, and whose first symptom is a
 * support ticket from a paying company. That is strictly worse than refusing to write the config at all,
 * and it is why `pithy add` refused `organization` outright for as long as a stub was the only thing it
 * could have written (#483).
 *
 * This answers nothing. It is a **marked absence**: a function carrying {@link UNIMPLEMENTED_SUBJECT},
 * which `payments()` reads at the Worker's entrypoint and refuses to boot on. So the two facts that used
 * to be in tension both hold — the adopter states `organization`, which is what they mean, and the Worker
 * still will not serve a request until somebody has written the resolver (#500).
 *
 * ## Why the check is at the entrypoint and not at composition
 *
 * `payments()` runs whenever a Worker's `pithy.config.ts` is *evaluated*, and the CLI evaluates that
 * module on nearly every command — `loadWorkerConfig` is how `migrate`, `deploy`, `doctor`, `upgrade` and
 * `add` itself learn what a Worker composes. A refusal at composition would therefore brick the whole CLI
 * in the adopter's project the moment the scaffold landed, which is exactly the #483 regression turned
 * inside out. `createEntrypoint` is the one seam the CLI never crosses: only the Worker's own
 * `src/index.ts` calls it. So the composition check stays what it was — an **absent** resolver is refused,
 * unchanged — and the unimplemented one is refused one seam later, where the audience is a request.
 */

/**
 * The brand. `Symbol.for` rather than a module-local symbol or function identity: a project that ends up
 * with two copies of `@pithy-sh/payments` resolved (a transitive range that did not dedupe) would compare
 * a placeholder from one copy against the marker from the other, and identity would answer no — booting a
 * Worker that denies every gate, which is the one outcome this file exists to prevent. A registered symbol
 * is the same symbol in both copies.
 */
const UNIMPLEMENTED_SUBJECT = Symbol.for("@pithy-sh/payments/unimplemented-subject");

/**
 * The scaffolded resolver: branded unimplemented, and a throw if anything ever calls it.
 *
 * A throw rather than `undefined`, and it is belt and braces rather than the mechanism — {@link
 * requireImplementedSubject} means a deployed Worker never gets here. What it covers is every other way
 * this function could be reached: a test composing the capability directly, a tool that assembles a
 * backend without an entrypoint (`pithy ui` reads the composed route tree that way), an adopter who
 * imported the placeholder somewhere of their own. In all of them a loud failure is the right answer and a
 * quiet `undefined` is the failure mode of the stub this replaces.
 */
export const unimplementedSubject: PaymentsSubjectResolver = Object.defineProperty(
  async () => {
    throw new InternalError({
      message: "The subject resolver for this project has not been written.",
      action: "Implement resolveSubject in this Worker's src/billing/subject.ts.",
      detail:
        'pithy add scaffolded an unimplemented resolveSubject and it is still the one composed. Under billingSubject: "organization" only the application can say which organization a caller is acting for.',
    });
  },
  UNIMPLEMENTED_SUBJECT,
  { value: true },
) as PaymentsSubjectResolver;

/** Whether this resolver is the scaffolded placeholder rather than something the adopter wrote. */
export function isUnimplementedSubject(resolver: PaymentsSubjectResolver | undefined): boolean {
  return resolver !== undefined && (resolver as unknown as Record<symbol, unknown>)[UNIMPLEMENTED_SUBJECT] === true;
}

/**
 * Refuse a Worker whose subject resolver is still the scaffolded placeholder.
 *
 * Called from the capability's `boot` hook, which `createEntrypoint` runs and nothing else does. The
 * message is the adopter's next action and nothing else: the file is named, the question it has to answer
 * is stated, and the alternative is the other billing mode.
 */
export function requireImplementedSubject(resolver: PaymentsSubjectResolver | undefined): void {
  if (!isUnimplementedSubject(resolver)) return;
  throw new ValidationError({
    message: "This project bills organizations, and its subject resolver is still the scaffolded placeholder.",
    action:
      'Implement resolveSubject in this Worker\'s src/billing/subject.ts, or set `billingSubject: "user"` in pithy.config.ts.',
    detail:
      "pithy add wrote src/billing/subject.ts exporting an unimplemented resolveSubject, and it is unchanged. Payments has no members table and never guesses a holder, so booting on it would deny every entitlement gate and raise payments/subject_unresolved on every write, for every caller, forever.",
  });
}
