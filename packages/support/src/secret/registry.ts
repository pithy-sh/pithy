// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";
import { type SupportConfig, supportNeedsBucket } from "../config/config";

/**
 * The secrets support reads — exactly one, and it is not support's own shape.
 *
 * Attachment bytes are written through the R2 binding and served as short-lived signed URLs, and
 * signing needs an S3 key pair. Rather than declare another credential shape, support declares the
 * *same* one `@pithy-sh/storage` owns, under its own name, through storage's factory. That is what
 * lets support point the `ObjectStore` seam at `SUPPORT_BUCKET` while inheriting none of storage's
 * tables, routes, or key policy — the same arrangement `@pithy-sh/media` already has.
 *
 * One factory rather than two hand-written declarations is also what keeps the name safe as a join
 * key: `aggregateSecretRegistries` allows a name declared twice only when every axis agrees, and two
 * hand-written copies drift where one factory cannot.
 */

/** The name support's R2 credential bundle is stored and resolved under, per environment. */
export const SUPPORT_R2_SECRET = "support-r2-credentials";

/**
 * The bucket binding it presigns — support's one optional binding, and the one an adopter declines when
 * attachments are off.
 *
 * **Declared, because the relation was prose and a command cannot read prose (#541).** With attachments
 * declined, `pithy doctor` printed `SUPPORT_BUCKET (r2) declined in pithy.config.ts` and then asked for
 * `support-r2-credentials` in the same run. The binding is stated on the entry now, so the secrets side
 * reads the decline the bindings side already reports.
 */
export const SUPPORT_BUCKET_BINDING = "SUPPORT_BUCKET";

/** The support capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const supportSecretsRegistry = r2CredentialsRegistry(SUPPORT_R2_SECRET, SUPPORT_BUCKET_BINDING);

/**
 * **The credential this composition cannot reach**, as the `inapplicableSecrets` contribution (#541).
 *
 * The headline case of that issue, and the one the binding field alone does not close. Joining a
 * credential to a **declined** binding only answers for a project that wrote a `declinedBindings` entry;
 * a project that simply turned attachments off never wrote one, because the binding was never declared
 * to decline — {@link supportNeedsBucket} suppresses it at composition. So `pithy doctor` kept asking
 * for `support-r2-credentials` on exactly the configuration the issue opens with.
 *
 * **The predicate already existed.** Support has answered *would this configuration ever put a byte in
 * `SUPPORT_BUCKET`* since #440, in one place, for the binding and the provisioner both. This is the
 * third caller of the same answer rather than a fourth reading of the three settings behind it — which
 * is the arrangement #440 landed precisely so that two callers could not disagree.
 *
 * The reason names the settings an operator would edit, all three of them, because any one of them
 * turns the bucket back on and a sentence naming only `attachments.enabled` would send a reader to the
 * wrong line.
 */
export function inapplicableAttachmentSecrets(config: SupportConfig): Record<string, string> {
  if (supportNeedsBucket(config)) return {};
  return {
    [SUPPORT_R2_SECRET]:
      "support() stores no attachments — attachments.enabled, attachments.retainRaw and submission.attachments.enabled are all off",
  };
}
