// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { getUsers, MAX_USER_LOOKUP } from "@pithy-sh/auth/src/admin/users";
import type { User } from "@pithy-sh/auth/src/data/betterAuth";
import type { AuthDatabase } from "@pithy-sh/auth/src/data/tables";
import { isInlineImage, userImageSource } from "@pithy-sh/auth/src/profile/profile";

/**
 * Turning membership rows into people, through the auth capability's own published reader.
 *
 * **Not a join this package writes.** `pithy_auth_users` belongs to `@pithy-sh/auth` and its shape is
 * its own; `getUsers` is the read that capability publishes for exactly this — an adopter holding a
 * membership table and needing names beside the ids — and it parses every row through the `User` codec
 * before returning it. Querying that table from here would be a second definition of somebody else's
 * schema, and second definitions drift in whichever direction nobody is looking.
 *
 * It matters more than a tidiness argument, because of what sits beside that table.
 * `pithy_auth_accounts` holds a provider's `accessToken`, `refreshToken` and `idToken` — live
 * credentials against a third party on the person's behalf. A hand-written roster join is one `selectAll`
 * and one added `innerJoin` away from carrying them out to a screen. Going through the published reader
 * means the projection is the `User` schema, so nothing that table later gains arrives here unannounced.
 *
 * ## The lookup is capped, so the cap is a chunk size rather than a limit
 *
 * `getUsers` refuses past {@link MAX_USER_LOOKUP} rather than truncating, because a statement takes a
 * bounded number of parameters and quietly answering for 100 of somebody's 140 members would be a wrong
 * roster presented as a right one. That is the right call for a library and the wrong answer to serve a
 * roster with, so this chunks: an organization with 150 people gets two statements and a complete list,
 * and every ordinary account gets one.
 *
 * Concurrent, because the chunks are independent. Duplicates across chunks are impossible — a membership
 * is unique per (organization, user) — and `getUsers` deduplicates within a chunk anyway, so merging the
 * maps can neither lose nor double anybody.
 *
 * ## A missing person is an absence, not an error
 *
 * A membership can outlive the user row it names. The roster has to draw that gap rather than fail the
 * screen, so {@link Person} carries nulls for a person who is gone and the membership is still listed —
 * which is also the only surface from which somebody can then remove it.
 *
 * ## The address is here and never in the trail
 *
 * A roster names people by their address, because that is what somebody matches against an invitation
 * they sent. That is a projection to a member of the same account, resolved live, and it is a different
 * thing from the audit trail — which records the *invitation's id* and refuses anything address-shaped,
 * because a trail is append-only, long-lived and nobody prunes it. Two surfaces, two rules, and the
 * reason they differ is retention rather than sensitivity.
 */

/** Where a member's mark is served from, under the capability's base path. */
export const MEMBERS_PATH_SEGMENT = "/members";

/**
 * The path a member's stored raster is served from.
 *
 * **Keyed by the membership and not by the user**, which is the whole of how this capability answers a
 * question `@pithy-sh/auth` deliberately does not: *is this caller entitled to see this person*. Auth
 * serves exactly one face — the caller's own, at a path carrying no id — because everyone signed in is a
 * peer there and an id in the path would be an enumeration oracle. Here the id is a membership, so the
 * route resolves it **within the acting organization** and a membership id from another account is the
 * same 404 as one that never existed. Entitlement is the membership, which is the answer this package
 * exists to give.
 */
export function memberImagePath(basePath: string, membershipId: string): string {
  // Encoded, like `organizationMarkPath`. A membership id is a UUID at the column and at every route
  // param that carries one, so nothing here needs escaping today — and the sibling that mints the other
  // image path already does it. Two functions stating two rules for the same kind of value is how the
  // one that skipped it becomes the one that breaks first.
  return `${basePath}${MEMBERS_PATH_SEGMENT}/${encodeURIComponent(membershipId)}/image`;
}

/** What a roster row needs about the membership it draws: its id, and whose it is. */
export interface PersonSubject {
  /** The membership's id — what the image path carries, and what a role change or removal names. */
  readonly id: string;
  /** The person it belongs to, in `pithy_auth_users`. */
  readonly userId: string;
}

/** One membership, resolved to the person holding it. */
export interface Person {
  /** The membership this row is about. Present whether or not the person behind it still is. */
  readonly membershipId: string;
  /** Whose membership it is. A plain reference across the capability boundary, never a joined row. */
  readonly userId: string;
  /** Their display name, or null when the user row is gone. A caller draws the gap; it does not fail. */
  readonly name: string | null;
  /** Their address, or null when the user row is gone. Resolved live, never copied into a trail. */
  readonly email: string | null;
  /**
   * What to draw their face from, through one `<img src>` whichever it is.
   *
   * A versioned URL on this origin for a stored raster, so a browser caches it and a roster costs one
   * request per face once rather than its bytes on every read. The value itself for a stored vector,
   * because an SVG fetched by *navigation* runs script in the origin that served it and an `<img src>` is
   * inert — the class of attack is removed rather than managed with headers. A provider's link passes
   * through as it is. Null when there is nothing, and then a caller draws initials, which is an answer
   * and not a placeholder.
   */
  readonly image: string | null;
  /**
   * Whether {@link Person.image} is bytes in the response rather than a URL.
   *
   * What a roster's size budget counts: inline values are re-sent on every read and cannot be cached, so
   * a caller paging a large account needs to know how much of its body is pictures.
   */
  readonly imageInline: boolean;
}

/**
 * Resolve every membership's person, in as few statements as D1 will take.
 *
 * A `Map` keyed by user id, because the caller already holds the order — it is holding the membership
 * list — and what it lacks is the lookup. An array in input order would quietly imply that a missing
 * person leaves a hole in it.
 */
export async function readPeople(auth: AuthDatabase, userIds: readonly string[]): Promise<Map<string, User>> {
  const chunks: string[][] = [];
  for (let at = 0; at < userIds.length; at += MAX_USER_LOOKUP) {
    chunks.push(userIds.slice(at, at + MAX_USER_LOOKUP));
  }
  const found = await Promise.all(chunks.map((chunk) => getUsers(auth, chunk)));
  return new Map(found.flatMap((page) => [...page]));
}

/**
 * Project one membership and the person behind it into a roster row.
 *
 * **Through `userImageSource`, not through a check on the column.** That function is where the three
 * shapes a picture column can hold are decided — a provider's link, stored raster bytes, a stored vector
 * — and it is `@pithy-sh/auth`'s because the column is. Deciding it again here would be a second reading
 * of somebody else's column, which is how the vector eventually gets a URL.
 *
 * The version is the user's `updatedAt`: the URL changes whenever the picture can have changed, so the
 * bytes may be served `immutable` and a browser never revalidates.
 */
export function asPerson(subject: PersonSubject, user: User | undefined, basePath: string): Person {
  if (user === undefined) {
    return {
      membershipId: subject.id,
      userId: subject.userId,
      name: null,
      email: null,
      image: null,
      imageInline: false,
    };
  }
  return {
    membershipId: subject.id,
    userId: subject.userId,
    name: user.name,
    email: user.email,
    image: userImageSource(user.image, memberImagePath(basePath, subject.id), user.updatedAt),
    imageInline: isInlineImage(user.image),
  };
}

/**
 * The roster: every membership handed in, resolved to a person, in the order it was given.
 *
 * The order is the caller's because the sort is the caller's — by role, by join date, by name — and this
 * read has no opinion about any of them. What it guarantees is that the list it returns is the list it
 * was given, one row for one membership, including the rows whose person is gone.
 */
export async function readRoster(
  auth: AuthDatabase,
  subjects: readonly PersonSubject[],
  basePath: string,
): Promise<Person[]> {
  const users = await readPeople(
    auth,
    subjects.map((subject) => subject.userId),
  );
  return subjects.map((subject) => asPerson(subject, users.get(subject.userId), basePath));
}
