// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ValidationError } from "../error/pithyError";

/**
 * Who may read a record, and learn that it exists — one convention, written once, for every capability
 * that holds a record a person owns.
 *
 * **Three levels, and the kit owns them.** `private` is the owner, acting for the organization the record
 * was written under; acting for any other organization, not even them. `organization` is any member of the
 * record's organization, acting for it. `public` is anyone holding the id or the URL, signed in or not.
 * Media and storage share the levels, the policy shape and the rules, so a record means the same thing in
 * both and there is one place the meaning can be wrong.
 *
 * **The project decides which levels exist, and which one a record gets when it names none.** `allowed` is
 * a set rather than a mode, because a set says everything a mode would and one thing it cannot:
 * `["private", "organization"]` is a guarantee that nothing can be published, even by mistake.
 */

/** Every level, weakest first. */
export const RECORD_VISIBILITIES = ["private", "organization", "public"] as const;

export const RecordVisibility = z
  .enum(RECORD_VISIBILITIES)
  .describe(
    "Who may read a record and learn it exists: `private` is the owner acting for the record's organization, `organization` is any member acting for it, `public` is anyone holding the id or URL.",
  );
export type RecordVisibility = z.infer<typeof RecordVisibility>;

/**
 * The levels a project allows, and the one a record gets when a write names none.
 *
 * **`default` is `private` and must be in `allowed`**, and a policy that breaks either is refused at
 * parse — which, for a capability, is at boot. **`allowed` defaults to all three**, so a capability that
 * accepted `public` before this policy existed is not narrowed by it.
 */
export const VisibilityPolicy = z
  .object({
    default: RecordVisibility.default("private").describe(
      "The level a record gets when a write names none. Private, so a forgotten field can never publish a file. Must be one of `allowed`.",
    ),
    allowed: z
      .array(RecordVisibility)
      .min(1)
      .default([...RECORD_VISIBILITIES])
      .describe(
        'The levels a write may name. All three by default. `["private", "organization"]` means nothing can ever be public; a write naming a level outside it is refused, never coerced.',
      ),
  })
  .describe("Which visibility levels this project allows, and the default for a write that names none.")
  .check((ctx) => {
    if (ctx.value.allowed.includes(ctx.value.default)) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["default"],
      message: `visibility.default is \`${ctx.value.default}\`, which visibility.allowed (${ctx.value.allowed.join(", ")}) does not include.`,
    });
  });
export type VisibilityPolicy = z.output<typeof VisibilityPolicy>;
export type VisibilityPolicyInput = z.input<typeof VisibilityPolicy>;

/**
 * The level a write records: the one it named, or the policy's default.
 *
 * **Refused, never coerced.** A level outside `allowed` is a mistake somewhere — a client that did not
 * know the policy, or a policy narrowed under a client — and quietly writing the default instead would
 * hide it until somebody wondered why a published file was private, or worse. `organization` with no
 * organization in force is refused for the same reason: a record no member can ever be acting for is not
 * an organization record, it is a private one that says otherwise.
 *
 * Both refusals are the caller's to fix, so the remedy is in `message`; `action` names the config key for
 * the operator who decides the policy.
 */
export function resolveVisibility(
  policy: VisibilityPolicy,
  requested: RecordVisibility | undefined,
  organizationId: string | null,
): RecordVisibility {
  const level = requested ?? policy.default;
  if (!policy.allowed.includes(level)) {
    throw new ValidationError({
      message: `Visibility \`${level}\` is not allowed here. Allowed: ${policy.allowed.join(", ")}.`,
      action: "Name one of visibility.allowed, or widen visibility.allowed in this Worker's pithy.config.ts.",
      detail: `requested ${requested ?? "(default)"} resolved to ${level}, outside ${policy.allowed.join(", ")}`,
      params: { visibility: level, allowed: policy.allowed.join(", ") },
    });
  }
  if (level === "organization" && organizationId === null) {
    throw new ValidationError({
      message: "Visibility `organization` needs an organization in force. Choose one, or name another level.",
      action: "Compose @pithy-sh/organization and choose an organization, or set a different visibility.default.",
      detail: "organization visibility requested with no acting organization",
      params: { visibility: level },
    });
  }
  return level;
}

/**
 * The levels a policy no longer allows — what `pithy doctor` searches records for after `allowed`
 * narrows. Narrowing never rewrites a record: making a public record private breaks every link already
 * published, so moving them is the adopter's explicit act, and this is how they find them.
 */
export function outsidePolicy(policy: VisibilityPolicy): RecordVisibility[] {
  return RECORD_VISIBILITIES.filter((level) => !policy.allowed.includes(level));
}
