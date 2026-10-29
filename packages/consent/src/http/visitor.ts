// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { CONSENT_VISITOR_HEADER } from "../client/api";
import { CONSENT_VISITOR_COOKIE } from "../config/config";

/**
 * The visitor's anonymous device id, in a first-party cookie.
 *
 * **Set only once the visitor has chosen**: a grant or a withdrawal writes it, and nothing else does — reading the
 * purposes or the visitor's own standing sets nothing, so a page that merely asks leaves no identifier behind.
 * `HttpOnly`, so no script reads it; `SameSite=Lax`, so it is not sent on a cross-site subrequest; `Secure` over
 * HTTPS; and it lives exactly as long as the anonymous window the consent counts for.
 */

/** A device id: a UUID, as this capability mints them. Anything else in the cookie or the header is ignored. */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A visitor's device id, and what carried it: this capability's cookie, or a phone's visitor header. */
export interface Visitor {
  readonly id: string;
  readonly carriedBy: "cookie" | "device";
}

/**
 * The visitor's device id, or `null` when there is none or it is not one of ours.
 *
 * The cookie decides whenever it is present, well-formed or not. The visitor header is read only from a request that
 * carries no cookie at all — a phone's — so a page's script can never set it to speak over a browser's cookie. Both
 * are held to the same shape, and neither is ever logged.
 */
export function readVisitor(c: Context<PithyHonoEnv>): Visitor | null {
  const cookie = getCookie(c, CONSENT_VISITOR_COOKIE);
  if (cookie !== undefined) return DEVICE_ID.test(cookie) ? { id: cookie, carriedBy: "cookie" } : null;
  return phoneDevice(c);
}

/**
 * The visitor id a request with no cookie at all sends in {@link CONSENT_VISITOR_HEADER}, or `null`. A phone holds
 * no cookie, so a signed-out visitor there is this id or nobody.
 */
export function phoneDevice(c: Context<PithyHonoEnv>): Visitor | null {
  if (c.req.raw.headers.has("cookie")) return null;
  const device = c.req.header(CONSENT_VISITOR_HEADER);
  return device !== undefined && DEVICE_ID.test(device) ? { id: device, carriedBy: "device" } : null;
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
