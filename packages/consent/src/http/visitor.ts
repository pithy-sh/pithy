// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { CONSENT_VISITOR_COOKIE } from "../config/config";

/**
 * The visitor's anonymous device id, in a first-party cookie.
 *
 * **Set only once the visitor has chosen**: a grant or a withdrawal writes it, and nothing else does — reading the
 * purposes or the visitor's own standing sets nothing, so a page that merely asks leaves no identifier behind.
 * `HttpOnly`, so no script reads it; `SameSite=Lax`, so it is not sent on a cross-site subrequest; `Secure` over
 * HTTPS; and it lives exactly as long as the anonymous window the consent counts for.
 */

/** A device id: a UUID, as this capability mints them. Anything else in the cookie is ignored. */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The visitor's device id from the request's cookie, or `null` when there is none or it is not one of ours. */
export function readVisitor(c: Context<PithyHonoEnv>): string | null {
  const value = getCookie(c, CONSENT_VISITOR_COOKIE);
  return value !== undefined && DEVICE_ID.test(value) ? value : null;
}

/** Hold the visitor's device id, for as long as their consent counts. */
export function writeVisitor(c: Context<PithyHonoEnv>, id: string, windowMs: number): void {
  setCookie(c, CONSENT_VISITOR_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: Math.floor(windowMs / 1000),
  });
}

/** Let go of the device id — once it has been merged into an account, it identifies nothing the account does not. */
export function clearVisitor(c: Context<PithyHonoEnv>): void {
  deleteCookie(c, CONSENT_VISITOR_COOKIE, { path: "/", secure: new URL(c.req.url).protocol === "https:" });
}
