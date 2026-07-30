// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The R2 S3-compatible credential pair. R2 speaks the S3 protocol, so presigned-URL signing needs
 * an access-key/secret-key pair (distinct from the CF API token). This is the canonical shape —
 * `@pithy-sh/secrets` validates the persisted credential envelope against it.
 */
export const R2Credentials = z
  .object({
    accessKeyId: z.string().min(1).describe("The R2 S3 access key id."),
    secretAccessKey: z.string().min(1).describe("The R2 S3 secret access key. Never logged or serialized to clients."),
  })
  .describe("The S3-compatible access-key/secret-key pair R2 uses to sign presigned URLs.");
export type R2Credentials = z.infer<typeof R2Credentials>;
