// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

// Its own module, importing nothing but zod, because `http/responses.ts` hands it to a browser and
// `./store.ts` beside it reaches the S3 client and the Workers runtime.

/** One part already stored against an in-flight multipart upload — what makes an upload resumable. */
export const UploadedPart = z
  .object({
    partNumber: z.number().int().min(1).describe("The part's 1-based index within the upload."),
    etag: z.string().min(1).describe("The part's entity tag, verbatim. Pass it back unchanged to complete."),
    size: z.number().int().nonnegative().describe("The part's size in bytes, as R2 stored it."),
  })
  .describe("One uploaded part — the unit a resumed upload skips re-sending.");
export type UploadedPart = z.output<typeof UploadedPart>;
