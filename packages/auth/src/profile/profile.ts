// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  INLINE_IMAGE_TYPES,
  StoredImage,
  storedImageSource,
  typeOfStoredImage,
} from "@pithy-sh/core/src/image/storedImage";
import { z } from "zod";

/**
 * A person's own display name and face — the two things about themselves they may change.
 *
 * ## Why the column takes two shapes
 *
 * `pithy_auth_users.image` has always held **a link**: a URL on whichever provider signed somebody in,
 * written once and never again. Two things follow, and both are things every adopter hits.
 *
 * **A linked avatar is a third-party fetch per face.** A roster of twenty people is twenty requests to
 * hosts the viewer did not choose, leaking their IP and referrer before they had done anything, and it
 * needs a CSP hole to render at all.
 *
 * **And nothing in the kit could change it.** Somebody who signed in with GitHub was called whatever
 * GitHub calls them, forever.
 *
 * So the column keeps accepting the provider URL it already holds — an existing row is untouched — and
 * gains a second accepted shape: bytes, stored as a bounded `data:` URL under the kit's one image rule
 * (`@pithy-sh/core/src/image/storedImage`). Where the column is settable by its subject, the host is
 * chosen by them.
 *
 * ## Why the rule is core's and not this package's
 *
 * `@pithy-sh/organization` holds an account's mark under the identical rule. It is the same object at a
 * different scale, and two answers to *what may be stored as an image* is one of them being wrong.
 *
 * ## Why this is `auth` and not `organization`
 *
 * Somebody in two accounts is the same person in both, and being asked to upload the same photograph
 * twice would be a product mistaking a membership for an identity. A single-tenant app — a consumer app
 * with no organizations at all — wants a display name and a face just as much, and should not have to
 * compose a tenancy capability to get one.
 *
 * ## What this package does *not* decide: who may see whose face
 *
 * Serving a raster by URL needs an answer to *is this caller entitled to see this person*, and this
 * capability has no such notion — everyone signed in is a peer. So the route here serves exactly one
 * image: **the caller's own**, at a path carrying no id at all, which cannot be an enumeration oracle
 * because there is nothing in it to enumerate. A roster of other people's faces is a tenancy question,
 * and `@pithy-sh/organization` answers it with membership, through the same core helpers.
 */

/**
 * The ceiling on a display name, in characters — applied on the **write** and not on the read.
 *
 * Deliberately asymmetric, and the reason is the one `data/kitFields.ts` already records: a bound on
 * the *column* schema turns a row a provider wrote before the bound existed into a row that throws on
 * every later read, and an admin listing reading a page of rows would then fail for every operator
 * rather than only for the author. A bound on the write is a 400 to the one caller who exceeded it.
 *
 * 256, which is longer than any name and short enough that a roster cannot be made expensive with it.
 */
export const MAX_DISPLAY_NAME_CHARS = 256;

/** A display name somebody may set for themselves. Trimmed by the caller; bounded here. */
export const DisplayName = z
  .string()
  .min(1)
  .max(MAX_DISPLAY_NAME_CHARS)
  .describe(
    "What this application calls somebody, as they typed it. Bounded on the write rather than on the column, so a longer name a provider wrote before the bound existed still reads.",
  );

/**
 * A picture linked on a provider's host — the shape the column has always held.
 *
 * Accepted rather than blessed: it is what Google, GitHub and Apple write at sign-in, and refusing it
 * would break every existing row. **Bounded and scheme-pinned**, because the only two things that can
 * be checked about somebody else's URL are how long it is and that it is not a `javascript:` or `data:`
 * payload wearing a URL's clothes.
 */
export const ProviderImageUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .describe(
    "An avatar on the provider's own host, written at sign-in. A third-party fetch per face — see the module note for why a stored image is preferred.",
  );

/**
 * What `pithy_auth_users.image` may hold: a provider's link, or bytes this application stores.
 *
 * The union is ordered link-first only for readability; the two shapes cannot both match, because a
 * `data:` URL is not `http(s):` and a stored image is pinned to an allowlisted media type inline in the
 * string. `data:text/html` matches neither, which is the whole of what makes this column safe to render.
 */
export const UserImage = z
  .union([ProviderImageUrl, StoredImage])
  .describe(
    "A person's picture: either a provider URL, as the column has always held, or bytes stored under the kit's image rule. Rendered only through `<img>`.",
  );
export type UserImage = z.output<typeof UserImage>;

/** The path a signed-in caller's own stored raster is served from, relative to the auth base path. */
export const PROFILE_IMAGE_PATH = "/profile/image";

/**
 * What a screen should draw this person's face from.
 *
 * Three answers, and a caller renders every one of them through the same `<img src>`:
 *
 * - **A provider link passes through.** It is already a URL and already cached by somebody else; there
 *   is nothing this origin can add to it.
 * - **A stored raster becomes a versioned URL on this origin**, so a browser caches it and a roster
 *   costs one request per face once rather than its bytes on every read.
 * - **A stored vector stays inline**, and the serving route refuses to serve one. An `<img src>` is
 *   inert by specification; a URL is navigable, and a navigated SVG runs script in the origin that
 *   served it. The class of attack is removed rather than managed with headers.
 *
 * `path` is where the owning capability serves bytes from — `basePath + PROFILE_IMAGE_PATH` here, and a
 * membership-scoped path in `@pithy-sh/organization`.
 */
export function userImageSource(image: string | null, path: string, version: Date | number): string | null {
  if (image === null) return null;
  // A provider link is not a stored image, and `storedImageSource` would answer null for it — which is
  // right for a column value nobody recognizes and wrong for the one shape this column was born
  // holding. Checked here rather than there, because core's rule is about stored bytes and this is the
  // package that also accepts a link.
  if (typeOfStoredImage(image) === null) return ProviderImageUrl.safeParse(image).success ? image : null;
  return storedImageSource(image, path, version);
}

/**
 * Whether this value is drawn inline rather than fetched.
 *
 * Exported for the projection tests and for a caller deciding whether a listing response is carrying
 * bytes — which is what `@pithy-sh/organization`'s roster budget counts.
 */
export function isInlineImage(image: string | null): boolean {
  if (image === null) return false;
  const type = typeOfStoredImage(image);
  return type !== null && INLINE_IMAGE_TYPES.includes(type);
}

/** A profile field a write supplied, and why it was refused. */
export interface ProfileRefusal {
  /** Which field failed — `name` or `image`. Named so a caller's message can say which. */
  readonly field: "name" | "image";
  /** Client-safe text. Says what is wrong without echoing the value back. */
  readonly message: string;
}

/**
 * Check the profile fields of a write, or say which one is refused and why.
 *
 * **This is the gate, and it sits at the database hook rather than at a route, deliberately.** Better
 * Auth's own `/update-user` endpoint pulls `name` and `image` out of the body and passes them straight
 * to the adapter — `parseUserInput` runs `validator.input` over the *additional* fields only, so the
 * mechanism `KIT_USER_FIELDS` relies on for `locale` does not reach these two at all. A validator
 * declared next to the column would therefore have been a validator nothing ran.
 *
 * A `databaseHooks.user` hook does reach it, and reaches every other producer with it: `/update-user`,
 * a social sign-in writing a provider's avatar, an admin route, and whatever the adopter composes next.
 * One rule, at the thing being called rather than at each call site.
 *
 * Absent fields pass: a write that does not mention a field is not a write to it.
 */
export function refuseUnsafeProfile(fields: { name?: unknown; image?: unknown }): ProfileRefusal | null {
  if (fields.name !== undefined && fields.name !== null && !DisplayName.safeParse(fields.name).success) {
    return {
      field: "name",
      message: `A name is between 1 and ${MAX_DISPLAY_NAME_CHARS} characters.`,
    };
  }
  if (fields.image !== undefined && fields.image !== null && !UserImage.safeParse(fields.image).success) {
    return {
      field: "image",
      // Says the shape rather than the reason it matters: a caller learns what to send, and an attacker
      // probing for `data:text/html` learns only that it was refused.
      message: "A picture must be an https URL or an image this application stores, within the size limit.",
    };
  }
  return null;
}

/** What a sign-in's profile fields become after the kit has made them safe to store. */
export interface SanitizedProfile {
  /** The name, truncated to the bound. Absent when the write did not mention one. */
  readonly name?: string;
  /** The picture, or null when the provider offered one this kit will not hold. */
  readonly image?: string | null;
}

/**
 * Make a **provider's** profile fields storable, rather than refusing them.
 *
 * The asymmetry with {@link refuseUnsafeProfile} is the point, and it is about whose act it is.
 *
 * A person setting their own name and picture is one caller doing one thing: a 400 tells them what to
 * send, and they send it. A provider's profile arrives in the middle of somebody signing in, and they
 * did not choose it — refusing there would mean **a person cannot sign in because Google gave them a
 * long display name.** So an over-long name is truncated and an avatar this kit will not hold becomes
 * no avatar, which draws initials, which is a real answer.
 *
 * Nothing unsafe reaches the column either way. The two paths differ in what they do about it, not in
 * what they accept.
 */
export function sanitizeProfile(fields: { name?: unknown; image?: unknown }): SanitizedProfile {
  const sanitized: { name?: string; image?: string | null } = {};
  if (typeof fields.name === "string" && !DisplayName.safeParse(fields.name).success) {
    // Truncated rather than dropped: Better Auth's user model requires a name, and an empty one is a
    // row every roster renders as a blank. A slice of a long name is still recognisably them.
    sanitized.name = fields.name.slice(0, MAX_DISPLAY_NAME_CHARS) || "—";
  }
  if (fields.image !== undefined && fields.image !== null && !UserImage.safeParse(fields.image).success) {
    sanitized.image = null;
  }
  return sanitized;
}
