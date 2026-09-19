// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { User } from "./data/betterAuth";
import { Device } from "./data/device";
import { authDatabase } from "./data/tables";

/**
 * **What a capability composed beside auth may read — handed to it, never imported by it** (#645).
 *
 * `@pithy-sh/auth` is an optional peer of `matchmaking` (an invite resolved by address), `support` (a sender
 * linked to an account) and `testers` (whether a tester has used the app). Each reached these modules by
 * `import()` behind a `try`, and a literal specifier is one a bundler resolves whether or not the branch
 * holding it ever runs — so a project without auth could not bundle any of the three.
 *
 * So `auth()` carries this object as `authPeer`, a dependent finds it among the composed capabilities in its
 * `compose` hook, and a host Worker — which composes nothing — is handed it by the entry `pithy` generates when
 * the project composes auth. The dependent names this package only in a type, which a bundler never sees.
 *
 * Read access to the account tables and the schemas that decode them, and nothing that writes: every
 * dependent reads who someone is, and none of them may decide it.
 *
 * Its own module, so that generated host entry imports these and not `capability.ts`, which brings Better
 * Auth and every route with it.
 */
export const authPeer = { authDatabase, User, Device } as const;

/** Auth's peer surface, by type — what `authPeer` holds. */
export type AuthPeer = typeof authPeer;
