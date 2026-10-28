// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import type { ConsentPurpose } from "../../consent/purpose";
import { type ConsentReader, composedConsent, composedConsentPurposes } from "../../consent/reader";
import { causeMessage } from "../../error/cause";
import type { PrivacyInventory } from "../../privacy/report";
import { composedProcessing, effectiveProcessing } from "../../processing/composed";
import { workerVersionMetadata } from "../../worker/identity";
import type { ControlPlaneContext } from "../context";
import type { EvidenceControlId, EvidenceState } from "../evidence/mapping";
import { readEvidencePack } from "../evidence/pack";
import type { ControlPlaneHandlerDeps } from "../http/handlers";
import type { ControlPlaneProcessingResponse } from "../http/responses";
import { EVIDENCE_READ_SCOPE, PRIVACY_READ_SCOPE } from "../scope/scope";
import { type ConsentInput, deriveProcessingRecord, workersAiRecipients } from "./derive";

/**
 * The reads behind the processing record: what the Worker composes, declares and records, gathered once per call.
 * Each read that fails costs the record what it would have said, named in `notDerivable`, and the record still
 * answers. A cause goes to the Worker's log and never into the record.
 *
 * **It never widens a scope.** The measures carry the evidence pack's states only when the connection also holds
 * `evidence:read`; without it they are cited by control and their state is null. A gap names a stored table or field
 * only when the connection also holds `privacy:read`; without it, the capability and the class.
 */

/** The privacy inventory, or null where the walk threw. */
function inventoryOf(c: Context<PithyHonoEnv>, deps: ControlPlaneHandlerDeps): PrivacyInventory | null {
  try {
    return deps.privacyInventory();
  } catch (cause) {
    c.var.log.warn("processing: privacy inventory unreadable", { reason: causeMessage(cause) ?? String(cause) });
    return null;
  }
}

/** What the composed consent capability says, or that none is composed. */
async function consentOf(c: Context<PithyHonoEnv>, deps: ControlPlaneHandlerDeps): Promise<ConsentInput> {
  const composition = deps.composition();
  const declared = composedConsentPurposes(composition);
  const reader = composedConsent(composition, c.env as Record<string, unknown>);
  if (reader === null) return { state: "not-composed", declared };
  if (reader.standings !== undefined) {
    try {
      return { state: "read", standings: await reader.standings() };
    } catch (cause) {
      c.var.log.warn("processing: consent record unreadable", { reason: causeMessage(cause) ?? String(cause) });
    }
  }
  return { state: "unreadable", catalog: catalogOf(c, reader) };
}

/** The reader's whole catalog from memory, or null where it cannot list one. */
function catalogOf(c: Context<PithyHonoEnv>, reader: ConsentReader): readonly ConsentPurpose[] | null {
  if (reader.purposes === undefined) return null;
  try {
    return reader.purposes();
  } catch (cause) {
    c.var.log.warn("processing: consent catalog unreadable", { reason: causeMessage(cause) ?? String(cause) });
    return null;
  }
}

/** Each control's state, read through the evidence pack, or null without `evidence:read`. */
async function measuresOf(
  c: Context<PithyHonoEnv>,
  deps: ControlPlaneHandlerDeps,
  context: ControlPlaneContext,
): Promise<Partial<Record<EvidenceControlId, EvidenceState>> | null> {
  if (!context.grantedScopes.includes(EVIDENCE_READ_SCOPE)) return null;
  const pack = await readEvidencePack(c, deps, context);
  return Object.fromEntries(pack.controls.map((entry) => [entry.control, entry.state]));
}

/** Read everything the record derives from, and derive it. */
export async function readProcessingRecord(
  c: Context<PithyHonoEnv>,
  deps: ControlPlaneHandlerDeps,
  context: ControlPlaneContext,
): Promise<ControlPlaneProcessingResponse> {
  const env = c.env as Record<string, unknown>;
  const composition = deps.composition();
  const [consent, measures] = await Promise.all([consentOf(c, deps), measuresOf(c, deps, context)]);
  const record = deriveProcessingRecord({
    activities: composedProcessing() ?? effectiveProcessing(undefined, composition),
    inventory: inventoryOf(c, deps),
    retention: deps.retention?.() ?? null,
    consent,
    bindingRecipients: workersAiRecipients(composition, env),
    measures,
    fieldNames: context.grantedScopes.includes(PRIVACY_READ_SCOPE),
  });
  return {
    environment: context.environment,
    generatedAt: deps.now().toISOString(),
    version: workerVersionMetadata(c.env).id,
    ...record,
  };
}
