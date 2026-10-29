// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { ConsentChoiceResponse, ConsentPurposesResponse, MyConsentResponse } from "../http/responses";
import type { GrantBody, WithdrawBody } from "../http/schemas";

/**
 * The consent routes, from a browser — what the scaffolded settings screen reads and writes through.
 *
 * **Browser-safe by construction**: it imports the response schemas and nothing that touches a table, a binding or
 * a Workers global, and the request bodies are types only. Every answer is validated against the capability's own
 * response schema, because the screen is read across a deploy boundary like any client.
 *
 * It never throws: a refusal comes back as `{ ok: false, code, message }`, so the screen renders the person's
 * situation rather than an exception, and `message` is the server's caller-facing sentence.
 */

/** Where the consent routes mount by default — the same default `ConsentConfig.basePath` carries. */
export const CONSENT_BASE_PATH = "/consent";

/**
 * The header a phone sends its visitor id in, where a browser holds the cookie. The id is a random UUID the app
 * mints for consent alone and keeps in its secure store, never the device id auth registers: that one is listed to
 * operators and written to the audit trail, so it proves nothing about who sent it.
 */
export const CONSENT_VISITOR_HEADER = "x-pithy-consent-visitor";

/**
 * The slice of `fetch` this module uses, declared structurally — payments' reason: the package compiles against
 * `@cloudflare/workers-types`, whose `RequestInit` has no `credentials`, and the cookie is the whole story here.
 */
export interface ConsentRequestInit {
  /** The HTTP method. Absent means GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The JSON body, already serialized. */
  body?: string;
  /** Cookie policy: `same-origin`, so the session and the visitor's device id travel and nothing else does. */
  credentials?: "include" | "same-origin" | "omit";
}

/** The slice of `Response` this module reads. */
export interface ConsentResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type ConsentFetch = (input: string, init?: ConsentRequestInit) => Promise<ConsentResponse>;

/** How the client reaches the Worker. */
export interface ConsentClientOptions {
  /** Where consent is mounted. Defaults to {@link CONSENT_BASE_PATH}. */
  readonly basePath?: string;
  /** The fetch to call with. Defaults to the global one; a test passes its own. */
  readonly fetch?: ConsentFetch;
}

/** One answer: the value, or why not. */
export type ConsentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The code a client answers with when the Worker's reply did not have the shape the schema promises. */
export const CONSENT_UNREADABLE = "consent/unreadable_response";

/** Read a refusal's code and caller-facing message off an error body, whatever shape it arrived in. */
function refusal(body: unknown, status: number): { ok: false; code: string; message: string } {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : `http/${status}`,
    message: typeof error?.message === "string" ? error.message : "That did not work.",
  };
}

/** The client over one base path. */
export function consentClient(options: ConsentClientOptions = {}) {
  const base = options.basePath ?? CONSENT_BASE_PATH;
  const call = async <S extends z.ZodType>(
    schema: S,
    path: string,
    init?: { method: string; body: string },
  ): Promise<ConsentResult<z.output<S>>> => {
    let response: ConsentResponse;
    try {
      const send = options.fetch ?? (fetch as unknown as ConsentFetch);
      response = await send(`${base}${path}`, {
        credentials: "same-origin",
        ...init,
        headers: { accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
      });
    } catch {
      return { ok: false, code: "network/unreachable", message: "We couldn't reach the server." };
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return refusal(body, response.status);
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, code: CONSENT_UNREADABLE, message: "The server answered in a shape we don't read." };
  };
  return {
    /** Every purpose this Worker asks consent for. */
    purposes: () => call(ConsentPurposesResponse, "/purposes"),
    /** The caller's own consents: where they stand, and every choice behind it. */
    me: () => call(MyConsentResponse, "/me"),
    /** Give consent to one purpose. */
    grant: (body: z.input<typeof GrantBody>) =>
      call(ConsentChoiceResponse, "/grants", { method: "POST", body: JSON.stringify(body) }),
    /** Withdraw consent from one purpose — the same request as granting. */
    withdraw: (body: z.input<typeof WithdrawBody>) =>
      call(ConsentChoiceResponse, "/withdrawals", { method: "POST", body: JSON.stringify(body) }),
  };
}

/** The client, as {@link consentClient} builds it. */
export type ConsentClient = ReturnType<typeof consentClient>;
