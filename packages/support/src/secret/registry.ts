// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";

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

/** The support capability's secret-registry slice — aggregated into the shared accessor at startup. */
export const supportSecretsRegistry = r2CredentialsRegistry(SUPPORT_R2_SECRET);
