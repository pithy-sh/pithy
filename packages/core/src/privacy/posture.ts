// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PrivacyClassName } from "./classes";
import { PRIVACY_SOURCES, type PrivacyInventory } from "./report";
import { RetirementVerdict } from "./retirement";

/**
 * **What a project declares about privacy, and what its running code holds — side by side** (#132).
 *
 * Two facts with two provenances, and the asymmetry between them is the useful part.
 *
 * - **Declared** is an **attestation**. The root `pithy.config.ts` names the classes a project handles
 *   (`privacy: { classes: ["pii", "phi"] }`), and `pithy deploy` writes them, with the console gate's verdict, into
 *   {@link PRIVACY_ATTESTATION_VAR} on every Worker it ships — the mechanism a Worker already learns its own name
 *   and project by. It is dated, and it describes the last deploy Pithy performed.
 * - **Observed** is a **derivation** — the inventory, walked from the composed schemas inside the Worker. It
 *   cannot be edited and cannot be stale.
 *
 * An attestation that disagrees with what the running code holds is itself the finding, which is why both are
 * reported and neither is an error Pithy raises. A project declaring `phi` with no PHI field marked is an
 * unfinished migration; one marking `phi` it never declared is a posture change nobody escalated.
 *
 * ## How stale an attestation can be
 *
 * **Usually it is absent rather than stale.** `pithy deploy` passes the var on wrangler's argv (`--var`), and a
 * plain `wrangler deploy` uploads only the vars its config names — wrangler sends `keep_bindings` for plain-text
 * vars only under `keep_vars: true` (read in wrangler 4.151.0's deploy path) — so a deploy Pithy did not perform
 * drops the attestation, and the posture reads `unattested`. Under `keep_vars: true` the var survives a raw
 * deploy and describes an older build. The Cloudflare version id cannot pair the two, because it is assigned at
 * upload, after the var is written; the manifest carries {@link PrivacyAttestation.attestedAt} beside the
 * version's own creation time instead, and a version created long after its attestation is that case.
 */

/** The var `pithy deploy` writes the attestation into. JSON, parsed by {@link privacyAttestation}. */
export const PRIVACY_ATTESTATION_VAR = "PITHY_PRIVACY";

/**
 * The console gate's verdict at the deploy that wrote the attestation. `off` never appears: `pithy deploy`
 * refuses a project whose rule is off, so no attestation is ever written for one.
 */
export const ConsoleGateVerdict = z
  .enum(["enforced", "unverifiable", "not_required"])
  .describe(
    "The console gate at the last `pithy deploy`: `enforced` (a Biome config was read and `suspicious/noConsole` is on), `unverifiable` (no Biome config Pithy could read — never reported as enforced), or `not_required` (the project declares no privacy class, so the gate does not apply). `off` never ships: deploy refuses it.",
  );
export type ConsoleGateVerdict = z.output<typeof ConsoleGateVerdict>;

/** What `pithy deploy` attests on a Worker it ships. */
export const PrivacyAttestation = z
  .object({
    classes: z
      .array(PrivacyClassName)
      .describe("The classes the root `pithy.config.ts` declared at that deploy. Empty when it declared none."),
    consoleGate: ConsoleGateVerdict.describe("The console gate's verdict at that deploy."),
    reason: z
      .string()
      .nullable()
      .describe("Why the gate is `unverifiable`, in one sentence. Null for every other verdict."),
    attestedAt: z.iso.datetime().describe("When `pithy deploy` wrote this attestation, ISO-8601."),
  })
  .describe(
    "The privacy declaration `pithy deploy` writes into a Worker's `PITHY_PRIVACY` var: an attestation, dated.",
  );
export type PrivacyAttestation = z.output<typeof PrivacyAttestation>;

/**
 * Read the attestation off a Worker's `env`. **Never throws**: an absent var, a value that is not JSON, and one
 * that does not parse are all `null`, which the posture reports as `unattested`. A string is parsed; an object
 * — what wrangler hands a JSON-typed var — is taken as it is.
 */
export function privacyAttestation(env: unknown): PrivacyAttestation | null {
  if (typeof env !== "object" || env === null) return null;
  const raw = (env as Record<string, unknown>)[PRIVACY_ATTESTATION_VAR];
  if (raw === undefined || raw === null) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = PrivacyAttestation.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The console gate as the manifest reports it: the attested verdict, or `unattested` when there is none. */
export const ConsoleGateState = z
  .enum(["enforced", "unverifiable", "not_required", "unattested"])
  .describe(
    "The console gate, as last attested: `enforced`, `unverifiable` (no readable Biome config — rendered as unverified, never as enforced), `not_required` (no class declared), or `unattested` (no `pithy deploy` attestation reached this Worker: a raw `wrangler deploy`, or a deploy from before this release).",
  );
export type ConsoleGateState = z.output<typeof ConsoleGateState>;

/**
 * The privacy block on `GET /control-plane/manifest`. Counts and classes only — no field names.
 *
 * **A project that declared nothing costs nothing.** When the attestation says no class is declared, the block
 * says exactly that and the walk does not run: `observed`, `counts` and both deltas are null, and `sources` is
 * empty, because nothing was looked at. That is the "behaves exactly as it does today" a project omitting the
 * key is promised. Every other case walks — a declared project to compare against, and an **unattested** one
 * because a Worker shipped around `pithy deploy` is precisely the one whose holdings someone needs to see.
 */
export const PrivacyPosture = z
  .object({
    declared: z
      .array(z.string().describe("A class name."))
      .nullable()
      .describe(
        "The classes the project declared, as attested by the last `pithy deploy`. Empty when it declared none; null when no attestation reached this Worker.",
      ),
    observed: z
      .array(z.string().describe("A class name."))
      .nullable()
      .describe(
        "Every class with at least one marked field in this Worker's storage schemas, derived at runtime. Null when the project declared no class, because nothing was walked.",
      ),
    counts: z
      .record(z.string(), z.number().int().nonnegative())
      .nullable()
      .describe(
        "Marked fields per observed class. A class with none is absent rather than zero. Null when nothing was walked.",
      ),
    observedNotDeclared: z
      .array(z.string().describe("A class name."))
      .nullable()
      .describe(
        "Classes the code holds that the project never declared — a posture change nobody escalated. Null when nothing was walked.",
      ),
    declaredNotObserved: z
      .array(z.string().describe("A class name."))
      .nullable()
      .describe(
        "Classes declared with no marked field behind them — an unfinished migration. Null when nothing was walked.",
      ),
    consoleGate: ConsoleGateState.describe("The console gate, as last attested."),
    consoleGateReason: z
      .string()
      .nullable()
      .describe("Why the gate is `unverifiable`, in one sentence. Null otherwise."),
    attestedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the attestation was written, ISO-8601, or null when there is none. A version created long after it is a build the attestation does not describe.",
      ),
    sources: z
      .array(z.enum(PRIVACY_SOURCES).describe("A storage kind: `d1` tables, or `kv` stores."))
      .describe(
        "The storage the observed classes were derived from. Anything not listed was not walked; empty when nothing was.",
      ),
    retirement: RetirementVerdict.optional().describe(
      "The field key's retirement guard (#390): whether a version due to leave is held live, and by what. Absent on a Worker whose core predates encrypted fields.",
    ),
  })
  .describe(
    "What this project declares about privacy and what its running code holds. Declared is an attestation dated to the last `pithy deploy`; observed is derived from the deployed schemas and cannot be edited.",
  );
export type PrivacyPosture = z.output<typeof PrivacyPosture>;

/** Whether an attestation says, explicitly, that the project declares no class — the one case that walks nothing. */
export function declaresNothing(attestation: PrivacyAttestation | null): boolean {
  return attestation !== null && attestation.classes.length === 0;
}

/**
 * The posture: the attestation beside the inventory, and the delta both ways. `inventory` is a thunk, read only
 * when something is declared or nothing is attested — see {@link PrivacyPosture}.
 */
export function privacyPosture(
  attestation: PrivacyAttestation | null,
  inventory: () => PrivacyInventory,
): PrivacyPosture {
  const gate = {
    consoleGate: attestation?.consoleGate ?? "unattested",
    consoleGateReason: attestation?.reason ?? null,
    attestedAt: attestation?.attestedAt ?? null,
  } as const;
  if (declaresNothing(attestation)) {
    return {
      declared: [],
      observed: null,
      counts: null,
      observedNotDeclared: null,
      declaredNotObserved: null,
      ...gate,
      sources: [],
    };
  }
  const walked = inventory();
  const declared = attestation?.classes ?? null;
  const declaredSet = new Set(declared ?? []);
  const observedSet = new Set(walked.observed);
  return {
    declared: declared === null ? null : [...declared],
    observed: [...walked.observed],
    counts: { ...walked.counts },
    observedNotDeclared: walked.observed.filter((name) => !declaredSet.has(name)),
    declaredNotObserved: (declared ?? []).filter((name) => !observedSet.has(name)),
    ...gate,
    sources: [...walked.sources],
  };
}
