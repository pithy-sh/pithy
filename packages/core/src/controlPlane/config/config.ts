// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  CONTROL_PLANE_CLOCK_SKEW_SECONDS,
  CONTROL_PLANE_JTI_TTL_SECONDS,
  CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS,
} from "../token/claims";

/**
 * The `control-plane` seam's config — the thin, user-owned surface in a Worker's `pithy.config.ts`.
 * Every field is `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * Parsed once at assembly, so a bad value fails on deploy rather than on the first management call.
 * That matters more here than anywhere else in the tree: the failure mode of a loose setting is not a
 * broken feature, it is an admin surface that accepts something it should have refused, and nothing
 * observable goes wrong until someone uses it.
 *
 * The defaults are deliberately tight. A management token lives one minute, is accepted one minute
 * either side of the clock, and its `jti` is remembered for three — comfortably longer than the widest
 * window any such token can be accepted in, which is the whole point of the cross-field rule below.
 *
 * None of this concerns Cloudflare's control plane. That is the outbound provisioning API behind
 * `@pithy-sh/cloudflare`; this is an inbound seam the adopter's own Worker exposes.
 */

/** A rooted path with no trailing slash — Hono mounts on exactly this string. */
const BASE_PATH_PATTERN = /^\/[a-zA-Z0-9\-._~]+(?:\/[a-zA-Z0-9\-._~]+)*$/;

/** Five minutes. The ceiling on skew and on a token's life: past it, "short-lived" stops being true. */
const MAX_WINDOW_SECONDS = 300;

/** An hour. The ceiling on replay memory — beyond it the set costs more than the risk it retires. */
const MAX_JTI_TTL_SECONDS = 3600;

/** Two hours. Chrome's own ceiling on a cached preflight; asking for more is asking for nothing. */
const MAX_CORS_MAX_AGE_SECONDS = 7200;

/**
 * Exactly an origin — what a browser puts in `Origin`, and nothing else.
 *
 * `z.url()` is not this check: it accepts `https://ops.example.com/`, a path, a wildcard, and `ftp://`.
 * Every one of those would sit in the config file looking correct and then match no browser `Origin`,
 * which fails as a bare refusal with nothing to read. The trailing-slash form is the one to expect,
 * because it is what an address bar shows the person copying the value.
 */
/** A DNS hostname, or a bracketed IP literal — `[::1]`, the address a Vite dev server binds by default. */
const ORIGIN_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IP_LITERAL = /^\[[0-9a-fA-F:.]+\]$/;

/**
 * Exactly an origin: a scheme a browser sends, a real host, and nothing after it.
 *
 * **It refuses a misunderstanding and forgives a spelling.** A path, a query, a fragment or a
 * credential means the writer thinks this value scopes something it does not — `https://ops.example.com/admin`
 * does not restrict anything to `/admin` — so those are refused at deploy, where the message can say so.
 * A trailing slash and an explicit `:443` are the same origin written a different way, and they are what
 * an address bar hands the person copying the value, so they are accepted and normalized by
 * `allowedOriginSet` rather than turned into a puzzle.
 *
 * `z.url()` is not this check: it accepts `https://*.example.com` — a wildcard is a legal hostname to
 * the URL parser and means nothing to a browser — and `ftp://x.com`, which has an origin too.
 */
const ORIGIN_ONLY = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  return ORIGIN_HOSTNAME.test(url.hostname) || IP_LITERAL.test(url.hostname);
};

export const ControlPlaneConfig = z
  .object({
    basePath: z
      .string()
      .regex(
        BASE_PATH_PATTERN,
        "A base path must start with `/`, carry no trailing slash, and contain no spaces (e.g. `/control-plane`).",
      )
      .default("/control-plane")
      .describe(
        "Where the seam's own routes mount — ping, manifest, and key management. Move it to sit under an existing admin prefix; it is not a security control, since every route behind it is default-denied anyway.",
      ),
    issuer: z
      .url()
      .default("https://app.pithy.sh")
      .describe(
        "The management-client origin a NEW connection is registered against — trust-critical, and effectively permanent. Every registered Worker verifies the `iss` on every call, so changing this is a migration across every connection, not a config edit. Verification reads the issuer stored on the connection; this only supplies the default written at connect time. It also seeds the browser origins this Worker answers a CORS preflight for (see `allowedOrigins`), which is the one thing about this value the Worker itself reads at runtime.",
      ),
    allowedOrigins: z
      .array(
        z
          .url()
          .refine(
            ORIGIN_ONLY,
            "An allowed origin is a scheme and a host — `https://ops.example.com`, `http://localhost:5173`, `http://[::1]:5173`. A path, a query or a credential is refused, because it looks like it scopes the entry and does not.",
          )
          .describe("One exact browser origin, spelled the way a browser sends it in `Origin`."),
      )
      .default([])
      .describe(
        "Browser origins allowed to call this Worker's control-plane surface cross-origin, **in addition to** `issuer`. Additive by construction: an entry here never removes `issuer`, so adding your own console cannot lock out the dashboard that was already working. Read from this config alone and never from a connection row — a preflight carries no credential, so answering one must cost no database read and must reveal nothing about which origins are registered. A management client you host yourself belongs here, or in `issuer` if it is the only one.",
      ),
    corsMaxAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_CORS_MAX_AGE_SECONDS)
      .default(600)
      .describe(
        "How long a browser may cache a preflight for this Worker's admin surface, in seconds. The allow-list it caches is a compile-time constant, so ten minutes costs nothing and saves the dashboard a second round trip on every call. **Set it to 0 while you are working out an allow-list**: a browser that cached a refusal keeps refusing for the full window after you have fixed `allowedOrigins`, which reads exactly like a change that did not take. Browsers cap this themselves, so a larger number here is a request, not a guarantee.",
      ),
    clockSkewSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WINDOW_SECONDS)
      .default(CONTROL_PLANE_CLOCK_SKEW_SECONDS)
      .describe(
        "How far a token's `iat`/`exp` may sit outside this Worker's clock and still be accepted. It absorbs real drift between two machines; it also widens the window a captured token stays live in, which is why it is capped rather than left to taste.",
      ),
    maxTokenLifetimeSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_WINDOW_SECONDS)
      .default(CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS)
      .describe(
        "The longest `exp - iat` this Worker will honor, whatever the token asks for. The adopter's ceiling, not the management client's choice: a client that mints hour-long tokens still gets one minute of them here.",
      ),
    jtiTtlSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_JTI_TTL_SECONDS)
      .default(CONTROL_PLANE_JTI_TTL_SECONDS)
      .describe(
        "How long a spent `jti` is remembered, so the same token cannot be presented twice. It must outlive the widest window a token is accepted in (lifetime plus skew) — a shorter memory forgets a token that is still valid, which is precisely the replay this exists to stop.",
      ),
    replayBackend: z
      .enum(["d1", "kv"])
      .default("d1")
      .describe(
        "Where spent token ids are recorded. `d1` claims with `INSERT … ON CONFLICT DO NOTHING`, so the primary key decides the race and one token is spendable exactly once, wherever the requests land — it costs one write on a path an administrator paces. `kv` skips that write and is best-effort: Workers KV has no compare-and-set and is eventually consistent across colocations, so one token presented twice in two places inside the propagation window can pass twice. Choose `kv` only where every management operation is idempotent.",
      ),
    keyRetentionDays: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(30)
      .describe(
        "How long an expired or revoked key stays on the connection row before pruning. Long enough to read a rotation back; short enough that verification never parses a growing blob. The audit trail is the history of record — the row is working state, not an archive.",
      ),
    maxKeys: z
      .number()
      .int()
      .min(2)
      .max(32)
      .default(8)
      .describe(
        "The most keys one connection may hold, live and superseded together. At least two, because a rotation overlap needs the new key registered while the old one still works — a ceiling of one would make safe rotation impossible.",
      ),
  })
  .describe(
    "Configuration for the inbound `control-plane` seam: where its routes mount, which management-client origin new connections trust, and the token and key-lifecycle bounds this Worker enforces.",
  )
  .check((ctx) => {
    // The replay set is only a defense while it still remembers a token that is still valid. If the
    // `jti` is forgotten first, the same signed token replays cleanly for the rest of its window — the
    // one misconfiguration that quietly reopens exactly what the set was added to close.
    //
    // The window is `lifetime + 2 × skew`, not `lifetime + skew`. Skew is allowed on **both** ends:
    // `iat` may be up to a skew in the future and `exp` is honored up to a skew after it passes, so a
    // token minted at the earliest instant this Worker would accept it is still accepted a full
    // `lifetime + 2 × skew` later. The check used to count one skew and was therefore satisfied by
    // settings that still left a replay window open.
    const widestWindow = ctx.value.maxTokenLifetimeSeconds + 2 * ctx.value.clockSkewSeconds;
    if (ctx.value.jtiTtlSeconds <= widestWindow) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["jtiTtlSeconds"],
        message: `jtiTtlSeconds (${ctx.value.jtiTtlSeconds}) must exceed maxTokenLifetimeSeconds + 2 × clockSkewSeconds (${widestWindow}). A token is accepted a clock skew either side of its window, so a shorter memory lets it outlive the record of it and replay.`,
      });
    }
  });
export type ControlPlaneConfig = z.output<typeof ControlPlaneConfig>;
export type ControlPlaneConfigInput = z.input<typeof ControlPlaneConfig>;
