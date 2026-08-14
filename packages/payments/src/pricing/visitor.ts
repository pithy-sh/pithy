// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PriceVisitor } from "./location";

/**
 * Where a signed-in visitor's Paddle customer comes from: `GET {basePath}/pricing`, asked of this
 * project's own Worker.
 *
 * **The same value the checkout charges, from the same row.** That route reads the provider-account map
 * keyed on the authenticated caller — `providerAccountForUser(db, "paddle", userId)` — and so does
 * `POST /payments/checkout`, which hands it to Paddle as `customer_id`. One reader, one row, so the
 * figure quoted and the figure charged cannot resolve location differently. A screen that derived a
 * customer id any other way would move this problem rather than solve it.
 *
 * **`ctm_…` is an identifier, not a credential.** It names a Paddle customer; it authorizes nothing.
 * Paddle's `PricePreview` reads a price with it and the publishable client token, which is the pair
 * Paddle publishes for exactly this. Nothing here widens what reaches a browser: the route is
 * `requireAuth()` and answers only about its own caller, so a visitor learns their own customer id and
 * no one else's.
 *
 * **Hand-written guard, no schema library, no absolute URL.** For the reason `../client/api.ts` gives at
 * length: this compiles into an adopter's browser program, and dragging the Worker's Zod graph in behind
 * it would break their build. The server's half of this response *is* a Zod object — `http/responses.ts`
 * — so the boundary is validated on both sides, each in the vocabulary its own program can carry.
 *
 * **A failure is not an answer, and this one fails honest.** Unreachable, refused, or unreadable all
 * return `null`, which resolves to the IP location and renders the figure labelled `Estimated.` A guess
 * that says it is a guess is the safe direction; the unsafe one would be treating a failed read as
 * proof there is no address on file.
 */

/** Where the payments routes mount by default. The same default `PaymentsConfig.basePath` carries. */
const DEFAULT_BASE_PATH = "/payments";

/** The one response field this reader needs. Declared structurally — see the header. */
interface PriceVisitorResponse {
  /** The body, whatever it turns out to be. */
  json(): Promise<unknown>;
  /** Whether the status was 2xx. */
  ok: boolean;
}

/** The fetch this reader uses. Narrower than the platform's on purpose: a URL, and a cookie. */
export type PriceVisitorFetch = (input: string, init: { credentials: "include" }) => Promise<PriceVisitorResponse>;

/** Where to ask, and what to ask with. Satisfied by `PaymentsClientOptions` without naming it. */
export interface PriceVisitorOptions {
  /** Where the payments routes mount. Defaults to `/payments`. */
  basePath?: string;
  /** The fetch to use. Defaults to the global one, and there is no answer without one. */
  fetch?: PriceVisitorFetch;
}

/** Whether a value is a plain record — the first step of the guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Paddle customer on a `GET /pricing` body, or null.
 *
 * Total, and refusing rather than coercing. `quotedFrom` is absent on an older Worker than this bundle,
 * null for a caller who has never bought anything, and a record naming a rail otherwise — three shapes
 * that all mean "no Paddle customer to price as" unless the third names `paddle` and carries a string.
 */
export function readPaddleCustomer(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const quotedFrom = body.quotedFrom;
  if (!isRecord(quotedFrom)) return null;
  if (quotedFrom.rail !== "paddle") return null;
  const providerAccountId = quotedFrom.providerAccountId;
  return typeof providerAccountId === "string" && providerAccountId.length > 0 ? providerAccountId : null;
}

/**
 * Ask this project's Worker who Paddle prices the signed-in caller as.
 *
 * Never throws, and never reports a failure: the caller's only sensible response to one is to quote from
 * the IP and say so, which is what `null` already means.
 */
export async function fetchPriceVisitor(options?: PriceVisitorOptions): Promise<PriceVisitor | null> {
  const fetcher = options?.fetch ?? (globalThis as { fetch?: PriceVisitorFetch }).fetch;
  if (!fetcher) return null;
  const base = options?.basePath ?? DEFAULT_BASE_PATH;
  try {
    const response = await fetcher(`${base}/pricing`, { credentials: "include" });
    if (!response.ok) return null;
    const customerId = readPaddleCustomer(await response.json());
    return customerId === null ? null : { customerId };
  } catch {
    return null;
  }
}
