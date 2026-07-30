// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { StorageVisibility } from "../data/storageObject";
import { MAX_OBJECT_KEY_BYTES } from "../object/key";
import { ReportedPart } from "../object/multipart";

/**
 * The request schemas for the storage routes. Every path parameter, query string and body is parsed
 * here before a handler sees it (CLAUDE.md §Zod: validate at every boundary), declared on the route
 * line with `zValidator(target, Schema, validationHook)` — so reading `routes.ts` tells you what a
 * route accepts without opening a handler. A failure maps to `validation/invalid_input` through
 * `fromZodError`.
 *
 * Two shapes deserve a note.
 *
 * **`path` is bounded and control-character-free, but otherwise unconstrained.** It is the adopter's
 * logical name and never becomes an R2 key, so `../` is not a traversal — it is just an odd file
 * name. What it *is* is a value that gets stored, listed, and eventually rendered somewhere, so a NUL
 * or a newline in it is rejected: those break log lines, headers, and `Content-Disposition` rather
 * than escaping a prefix. The length bound matches R2's key limit even though the path is not a key,
 * because an unbounded text column is an easy way to fill someone's database.
 *
 * **`size` is required on upload-init.** A presigned PUT signs `Content-Length`, so the client must
 * commit to a byte count before a URL can be minted at all. It is also what the `pending` row
 * reserves against the owner's quota — a null size would reserve nothing and make the quota a
 * suggestion under concurrency (see `quota/quota.ts`).
 */

/**
 * Whether a path is free of C0 control characters and DEL. Written as a scan rather than a regex
 * because a regex spelling this needs literal control-character escapes, which Biome rejects — and
 * the rule it rejects them under is a good one.
 */
function isPrintablePath(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The logical path field, shared by upload-init, rename, and copy so the three cannot drift apart. */
const logicalPath = z
  .string()
  .min(1)
  .max(MAX_OBJECT_KEY_BYTES)
  .refine(isPrintablePath, { error: "A path may not contain control characters." })
  .describe(
    "The file's logical name, e.g. `invoices/2026/q3.pdf`. Stored, indexed, and listable by prefix; never part of the R2 key, so slashes are naming, not directories.",
  );

/**
 * The `:id` path parameter every single-object route carries. Deliberately a bounded generic string
 * and **not** `z.uuid()`: ids are minted with `crypto.randomUUID()`, but this is a shape check, not a
 * lookup. A well-formed id nobody owns must still reach the handler and answer `storage/not_found`
 * (404) — the answer that keeps the route from being an enumeration oracle. A UUID check would turn
 * that into a 400 and hand back a shape the caller could probe against.
 */
export const ObjectIdParam = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .describe("The object id from the path. Bounded so an unbounded string never reaches the database."),
  })
  .describe("The path parameter identifying one stored object.");
export type ObjectIdParam = z.output<typeof ObjectIdParam>;

/**
 * The `:token` path parameter the two share routes carry. Bounded only — a minted token is 43
 * base64url characters, but the bound exists to stop an unbounded string reaching the shares table,
 * not to pre-empt the lookup. An unknown-but-well-formed token still answers `storage/not_found`.
 */
export const ShareTokenParam = z
  .object({
    token: z
      .string()
      .min(1)
      .max(128)
      .describe("The share token from the path — the credential itself, checked against the shares table."),
  })
  .describe("The path parameter identifying one share link.");
export type ShareTokenParam = z.output<typeof ShareTokenParam>;

/**
 * The query string an object read accepts. Only `?download=1` means anything; every other value is
 * simply not a download, which is what the bare string comparison said before and still says. Typed
 * as a bounded string rather than `z.literal("1")` because `?download=0` is a request that works
 * today, and a literal would answer it with a 400.
 */
export const ObjectReadQuery = z
  .object({
    download: z
      .string()
      .max(16)
      .optional()
      .describe("`1` serves the bytes as an attachment. Anything else, or omitted, serves them inline."),
  })
  .describe("Query parameters for reading an object's bytes, by id or through a share link.");
export type ObjectReadQuery = z.output<typeof ObjectReadQuery>;

export const CreateUploadInput = z
  .object({
    path: logicalPath,
    contentType: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "The file's MIME type, as you intend it. A declaration, not a constraint: a presigned PUT cannot sign a content type, so completion replaces this with the type R2 actually stored.",
      ),
    size: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The exact byte count. Required: the presigned PUT signs Content-Length, and the pending row reserves these bytes against the owner's quota the moment it is written.",
      ),
    visibility: StorageVisibility.optional().describe(
      "Who may read the file once stored. Omitted takes the configured default, which is private.",
    ),
  })
  .describe("A request to start an upload — what the file is called, what it is, and how big it is.");
export type CreateUploadInput = z.output<typeof CreateUploadInput>;

export const CompleteUploadInput = z
  .object({
    parts: z
      .array(ReportedPart)
      .default([])
      .describe(
        "Every part's number and the ETag R2 answered its PUT with. Empty for a single-PUT upload, which has no parts to assemble.",
      ),
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        "Lowercase hex SHA-256 the client computed over the bytes it sent. Recorded, not verified server-side.",
      ),
  })
  .describe("A request to finalize an upload — the parts to assemble, and optionally what was sent.");
export type CompleteUploadInput = z.output<typeof CompleteUploadInput>;

export const UpdateObjectInput = z
  .object({
    path: logicalPath.optional(),
    visibility: StorageVisibility.optional().describe(
      "Change who may read the file. Takes effect on the next request.",
    ),
  })
  .describe("A rename, a visibility change, or both. At least one field must be present.")
  .check((ctx) => {
    // An empty patch is almost always a client bug — a field name that did not survive serialization.
    // Answering 200 to it would hide that; answering 400 names it.
    if (ctx.value.path === undefined && ctx.value.visibility === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: [],
        message: "Send a path, a visibility, or both — an empty patch changes nothing.",
      });
    }
  });
export type UpdateObjectInput = z.output<typeof UpdateObjectInput>;

export const CopyObjectInput = z
  .object({ path: logicalPath })
  .describe("A server-side copy — the new file's logical path. The bytes never leave R2.");
export type CopyObjectInput = z.output<typeof CopyObjectInput>;

/** One year. A share that outlives the memory of granting it is indistinguishable from a public file. */
const MAX_SHARE_TTL_SECONDS = 365 * 24 * 60 * 60;

export const CreateShareInput = z
  .object({
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_SHARE_TTL_SECONDS)
      .optional()
      .describe(
        "How long the link works, in seconds. Omitted never expires — revocation is then the only way to end it, which is a deliberate choice rather than a default.",
      ),
  })
  .describe("A request to mint a revocable share link for one file.");
export type CreateShareInput = z.output<typeof CreateShareInput>;

export const ListObjectsQuery = z
  .object({
    prefix: z
      .string()
      .max(MAX_OBJECT_KEY_BYTES)
      .optional()
      .describe("Only files whose logical path starts with this. Omitted lists everything you own."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("The `cursor` a previous page returned. Opaque — pass it back unchanged to advance."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Files per page. Defaults to 50, capped at 100 so one request cannot scan an entire owner's files."),
  })
  .describe("Query parameters for the owner's file listing.");
export type ListObjectsQuery = z.output<typeof ListObjectsQuery>;
