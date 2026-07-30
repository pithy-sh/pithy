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
        "The management-client origin a NEW connection is registered against — trust-critical, and effectively permanent. Every registered Worker verifies the `iss` on every call, so changing this is a migration across every connection, not a config edit. Verification reads the issuer stored on the connection; this only supplies the default written at connect time.",
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
        "The longest `exp - iat` this Worker will honour, whatever the token asks for. The adopter's ceiling, not the management client's choice: a client that mints hour-long tokens still gets one minute of them here.",
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
    // The replay set is only a defence while it still remembers a token that is still valid. If the
    // `jti` is forgotten first, the same signed token replays cleanly for the rest of its window — the
    // one misconfiguration that quietly reopens exactly what the set was added to close.
    //
    // The window is `lifetime + 2 × skew`, not `lifetime + skew`. Skew is allowed on **both** ends:
    // `iat` may be up to a skew in the future and `exp` is honoured up to a skew after it passes, so a
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
