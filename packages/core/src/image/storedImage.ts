// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What may be stored as an image, and how it is served — stated once, for every capability that holds
 * a small picture in a column.
 *
 * Two capabilities hold one: `@pithy-sh/auth` keeps a person's face, `@pithy-sh/organization` keeps an
 * account's mark. They are the same object at different scales, and **two answers to *what may be
 * stored as an image* is one of them being wrong.** So the allowlist, the ceiling, the derived byte
 * figure and the serving split live here and are imported, exactly as `normalizeAddress` moved here in
 * `#280`.
 *
 * ## Stored, not linked
 *
 * A remote URL means the page fetching an attacker-chosen host from a screen listing people, leaking
 * the viewer's IP and referrer before they had done anything, and it needs a CSP hole to render at all.
 * A bounded `data:` URL in a column has no third party in it.
 *
 * ## Rendered through `<img>`, never inlined
 *
 * A browser disables scripting inside an `<img>` by specification, and that is the entire basis for
 * accepting SVG here at all. Nothing in the kit writes one of these values into a document.
 *
 * ## Rasters get a URL, vectors never do — and that is the security answer, not a mitigation
 *
 * A `data:` URL has one property it cannot have: **it cannot be cached.** It is inline in the response
 * body, so a roster of twenty faces re-sends twenty images on every read, forever. Serving from the
 * app's own origin fixes that and costs one real hazard — **an SVG fetched by *navigation* runs script
 * in the origin that served it.** An `<img src>` is inert; a URL is navigable.
 *
 * So a vector never gets a URL. {@link storedImageBytes} answers null for one, the serving route 404s
 * on null, and there is no arrangement of ids and versions that makes the origin return an SVG. The
 * class of attack is removed rather than managed with headers, and there is no header anybody has to
 * keep right.
 */

/**
 * The image types a stored picture may be.
 *
 * Three rasters and one vector. The vector is here because `<img>` renders it inertly and a mark drawn
 * as one is a few hundred bytes; every rule below that treats it differently is treating *navigability*
 * differently, not the format.
 */
export const STORED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;

/** One of {@link STORED_IMAGE_TYPES}. */
export type StoredImageType = (typeof STORED_IMAGE_TYPES)[number];

/**
 * The types that stay inline whatever else happens.
 *
 * One entry, and the module note argues it at length. Written as a list rather than as a comparison so
 * that a second scriptable format added to {@link STORED_IMAGE_TYPES} one day is added here too, next
 * to the reason.
 */
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/svg+xml"];

/**
 * The ceiling on a stored image, in characters of `data:` URL.
 *
 * 32KB of base64, which is about 24KB of image. A face drawn at 34px does not need more, and the
 * ceiling is what stops one row making every read expensive: the record, the account menu and the
 * chooser all carry it.
 */
export const MAX_STORED_IMAGE_CHARS = 32 * 1024;

/**
 * The longest `data:<type>;base64,` a stored image can begin with, in characters.
 *
 * Derived from the allowlist rather than written down, so a longer type name added above cannot leave a
 * ceiling below it stale. `image/svg+xml` is the long one today, at 26 characters.
 */
export const LONGEST_STORED_IMAGE_PREFIX = Math.max(...STORED_IMAGE_TYPES.map((type) => `data:${type};base64,`.length));

/**
 * The largest file a browser may encode into that ceiling, in bytes of image.
 *
 * **Not `MAX_STORED_IMAGE_CHARS * 3 / 4`, and the difference is a bug that shipped once.** That is the
 * base64 inverse, and it silently assumes the stored string is base64 and nothing else. It is not: it
 * is `data:<type>;base64,` and *then* the base64. A file at the plain inverse encodes to 22–26
 * characters more than the column will take, so it passes a picker's own check and is refused by Zod —
 * the person gets a validator's sentence where the product had written them one of its own.
 *
 * Base64 is four characters per three bytes and rounds up to a whole group, so the arithmetic runs
 * backwards from the characters left after the prefix: `floor((chars - prefix) / 4)` groups, three
 * bytes each. Derived from the *longest* prefix, because one ceiling has to hold for every type a
 * picker offers and the tightest constraint is the one that binds.
 *
 * **This is the figure a client-side picker checks a file against before encoding it.** The column
 * enforces {@link MAX_STORED_IMAGE_CHARS} on the whole string, which is the bound that matters; this is
 * the same fact stated as bytes of image, so a picker and a column cannot disagree.
 */
export const MAX_STORED_IMAGE_BYTES = 3 * Math.floor((MAX_STORED_IMAGE_CHARS - LONGEST_STORED_IMAGE_PREFIX) / 4);

/** `data:<type>;base64,<payload>` and nothing else — no bare URL, no `data:text/html`, no charset games. */
const STORED_IMAGE_PATTERN = new RegExp(
  `^data:(?:${STORED_IMAGE_TYPES.join("|").replace(/\+/g, "\\+")});base64,[A-Za-z0-9+/]+=*$`,
);

/**
 * A stored image, validated at the column and therefore at every boundary that decodes a row.
 *
 * **The pattern is an allowlist of types, not a check that the string starts with `data:`.**
 * `data:text/html` is a `data:` URL too, and the difference between the two is the whole of what makes
 * this column safe to render. Anchored at both ends, so nothing follows the payload.
 */
export const StoredImage = z
  .string()
  .max(MAX_STORED_IMAGE_CHARS)
  .regex(STORED_IMAGE_PATTERN)
  .describe(
    "An image held as a base64 `data:` URL of an allowed type, bounded to 32KB. Stored rather than linked, and rendered only through `<img>` — see `@pithy-sh/core/src/image/storedImage`.",
  );
export type StoredImage = z.output<typeof StoredImage>;

/** The `data:` prefix a stored image of `type` begins with. */
function prefixOf(type: string): string {
  return `data:${type};base64,`;
}

/** The type a stored image declares, or null when it is not a value this rule accepts. */
export function typeOfStoredImage(stored: string): StoredImageType | null {
  return STORED_IMAGE_TYPES.find((type) => stored.startsWith(prefixOf(type))) ?? null;
}

/**
 * What a screen should draw this image from.
 *
 * A URL for a raster, the stored value itself for a vector, and null for nothing. The caller renders
 * whichever it gets through the same `<img src>`, so no screen has to know which it was handed.
 *
 * `path` is the route the owning capability serves bytes from, already carrying whatever identifies the
 * subject — this function appends only the version, because the version is the half that has to be
 * right for `immutable` to be honest.
 *
 * The version is the owning row's `updatedAt`: the URL changes whenever the image can have changed, so
 * the response may be `immutable` and a browser never revalidates. It over-invalidates slightly — a
 * rename busts a picture that did not change — which is one wasted fetch on a rare action, against a
 * hash column and a migration to carry it.
 */
export function storedImageSource(stored: string | null, path: string, version: Date | number): string | null {
  if (stored === null) return null;
  const type = typeOfStoredImage(stored);
  // Not a value this build recognizes. Answered as nothing rather than served: a face falls back to
  // initials, which is a real answer, and a value the allowlist does not match is one the column should
  // never have held.
  if (type === null) return null;
  if (INLINE_IMAGE_TYPES.includes(type)) return stored;
  const at = version instanceof Date ? version.getTime() : version;
  return `${path}?v=${at}`;
}

/** A stored image decoded into what a response body needs. */
export interface StoredImageBytes {
  /** The `Content-Type` to serve it as. Always one of {@link STORED_IMAGE_TYPES}, never sniffed. */
  readonly type: StoredImageType;
  /** The image itself. */
  readonly body: Uint8Array;
}

/**
 * Decode a stored image for serving, or null when it must not be served.
 *
 * **Null for a vector, and that is the gate rather than a caution.** The route asks this and answers
 * 404 when it gets null, so there is no arrangement of ids and versions that makes the origin return an
 * SVG. The module note gives the reason.
 *
 * Null too for anything the allowlist does not match, which the column should have refused on the way
 * in — this is the second place that is true, and a value that reached the column past a bug does not
 * get served out of it.
 */
export function storedImageBytes(stored: string | null): StoredImageBytes | null {
  if (stored === null) return null;
  const type = typeOfStoredImage(stored);
  if (type === null || INLINE_IMAGE_TYPES.includes(type)) return null;
  const payload = stored.slice(prefixOf(type).length);
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    // A column value that is not decodable base64. Nothing to serve, and nothing to say about it here.
    return null;
  }
  const body = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) body[at] = binary.charCodeAt(at);
  return { type, body };
}

/**
 * The headers a served image carries.
 *
 * **`immutable`, which is only honest because the URL carries a version.** {@link storedImageSource}
 * puts the owning row's `updatedAt` in the query, so a changed image is a different URL and a browser
 * that never revalidates can never show a stale one.
 *
 * **`private`, because the fetch is authorized against a session.** A shared cache holding this would
 * be one person's face served to whoever asked next.
 *
 * **`nosniff`, because the type is the allowlist's and must not be re-guessed.** Content sniffing is
 * how a file served as an image gets treated as something else, and the whole safety of this route is
 * that the type is one of three rasters.
 */
export const STORED_IMAGE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};
