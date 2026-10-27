// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The evidence pack's mapping table (#821): which controls the Worker derives evidence for, and the SOC 2 and
 * ISO/IEC 27001:2022 references each one answers.
 *
 * **Evidence, never a verdict.** Each control the pack reports carries the facts it read, where each came from,
 * and one of three states. None of them is a judgment about a framework: an auditor decides that, and nothing
 * here or on the wire uses the vocabulary of one.
 *
 * **Versioned, and the version travels with every pack.** A reference moving, a control joining or leaving, or
 * a rule for a state changing is a new {@link EVIDENCE_MAPPING_VERSION}, so a pack read last quarter and one read
 * today can be told apart by the number on them. A control needing a declaration the kit does not hold is a
 * later version of this table, never a guess in this one.
 *
 * Zod-only, so a management client can import the table and the vocabulary without the Worker's runtime.
 */

/** The version of this table. Bumped whenever a control, a reference, or a state rule changes. */
export const EVIDENCE_MAPPING_VERSION = 1;

/** The seven controls, by id. Stable: a client keys on these, and the title may be reworded. */
export const EVIDENCE_CONTROL_IDS = [
  "audit-logging",
  "route-verification",
  "management-access",
  "key-rotation",
  "change-history",
  "data-protection",
  "csrf",
] as const;

/** One control's id. */
export const EvidenceControlId = z
  .enum(EVIDENCE_CONTROL_IDS)
  .describe("The control this entry reports on, as a stable id. Keyed on by clients; the title may be reworded.");
export type EvidenceControlId = z.infer<typeof EvidenceControlId>;

/**
 * What the Worker could say about a control. Three states, and none of them a verdict.
 *
 * - `evidenced`: the facts are present.
 * - `gap`: something is missing, and the entry names what.
 * - `not-derivable`: the Worker cannot say, and the entry names why.
 */
export const EvidenceState = z
  .enum(["evidenced", "gap", "not-derivable"])
  .describe(
    "What the Worker could say about this control: `evidenced` when the facts are present, `gap` when something is missing and the entry names what, `not-derivable` when the Worker cannot say and the entry names why. Evidence for an auditor, never a judgment.",
  );
export type EvidenceState = z.infer<typeof EvidenceState>;

/**
 * Where a fact came from: the declaration or record the Worker read it off. Every fact names one, so an auditor
 * can follow each back to the code or the row it is about.
 */
export const EvidenceSource = z
  .enum([
    "composition",
    "auditRecorder",
    "bindings",
    "routeSpec",
    "connection",
    "connectionKeys",
    "capabilityHealth",
    "fieldKeyRetirement",
    "migrationLedger",
    "privacyMarkers",
    "encryptedMarkers",
    "privacyAttestation",
    "sameOriginGate",
  ])
  .describe(
    "The declaration a fact was read from: `composition` (the capabilities this Worker composes), `auditRecorder` (the audit emit seam), `bindings` (this Worker's bindings), `routeSpec` (each route's `describeRoute`), `connection` (a control-plane connection's row), `connectionKeys` (its registered keys), `capabilityHealth` (a capability's declared health summary), `fieldKeyRetirement` (the field key's retirement guard), `migrationLedger` (a database's migration ledger), `privacyMarkers` (privacy-class markers on stored schemas), `encryptedMarkers` (`encrypted()` markers), `privacyAttestation` (the classes the last `pithy deploy` declared), or `sameOriginGate` (the same-origin policy a capability publishes).",
  );
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** One row of the table: what a control is called and the framework references it answers. */
export interface EvidenceControl {
  readonly title: string;
  readonly soc2: readonly string[];
  readonly iso27001: readonly string[];
}

/**
 * The table itself, keyed by control so every id has exactly one row by construction. The pack reports them in
 * {@link EVIDENCE_CONTROL_IDS} order. SOC 2 references are the AICPA Trust Services Criteria; ISO references are
 * ISO/IEC 27001:2022 Annex A.
 */
export const EVIDENCE_CONTROLS: Readonly<Record<EvidenceControlId, EvidenceControl>> = {
  "audit-logging": { title: "Audit logging in force", soc2: ["CC7.2"], iso27001: ["A.8.15"] },
  "route-verification": {
    title: "Every route declares how a caller is verified",
    soc2: ["CC6.1"],
    iso27001: ["A.5.15"],
  },
  "management-access": {
    title: "Management access attributed and scoped",
    soc2: ["CC6.2", "CC6.3"],
    iso27001: ["A.5.18"],
  },
  "key-rotation": { title: "Keys and secrets rotate", soc2: ["CC6.1"], iso27001: ["A.8.24"] },
  "change-history": { title: "Change history per environment", soc2: ["CC8.1"], iso27001: ["A.8.32"] },
  "data-protection": { title: "Data classified and encrypted at rest", soc2: ["C1.1"], iso27001: ["A.8.24"] },
  csrf: { title: "CSRF wherever cookie mode is", soc2: ["CC6.6"], iso27001: ["A.8.26"] },
};

/** The capability whose composition is the audit-logging control's subject. Named in the gap it reports. */
export const AUDIT_PACKAGE = "@pithy-sh/audit";

/** The capability whose declared health carries secrets' rotation cadence and what is overdue. */
export const SECRETS_CAPABILITY = "secrets";

/** Its package, named in a reason. */
export const SECRETS_PACKAGE = "@pithy-sh/secrets";
