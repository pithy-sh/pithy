// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PreconditionFailedError, UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * Where a workload identity token comes from, for an agent in CI with no key at all (#723, #722,
 * `docs/AGENT-ACCESS.md` §6.2).
 *
 * **Three sources, one shape.** GitHub Actions hands a job a request URL and a bearer for it, and mints a token for
 * whatever audience is asked — so the server asks for the environment's own origin, which is what the trust was
 * registered with. GitLab CI mints at job start into a variable the job's `id_tokens:` block names, with the
 * audience the block states. A custom issuer is the same as GitLab's from here: a variable, named. Each is
 * fetched when the server starts, presented on every call, and fetched again before it expires.
 *
 * **Held in memory and nowhere else.** The token is a bearer for its lifetime: anyone holding a live one may call
 * as this workload. Nothing here writes it — not to disk, not to a log, not into an error — and a refusal names
 * the variable, never its value.
 */

/** Where the server reads its workload token. Stored on the connection record, never the token itself. */
export const WorkloadTokenSource = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("github").describe("GitHub Actions' token request endpoint.") })
      .describe(
        "GitHub Actions: requested from `ACTIONS_ID_TOKEN_REQUEST_URL` for the trust's audience. The workflow needs `id-token: write`.",
      ),
    z
      .object({
        kind: z.literal("gitlab").describe("A GitLab CI `id_tokens:` variable."),
        variable: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .describe("The variable the job's `id_tokens:` block names, e.g. `MCP_ID_TOKEN`."),
      })
      .describe("GitLab CI: read from the variable `id_tokens:` names, minted with the audience that block states."),
    z
      .object({
        kind: z.literal("env").describe("A custom issuer's token, in a named variable."),
        variable: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .describe("The environment variable holding the token."),
      })
      .describe("A custom issuer: read from a named environment variable."),
  ])
  .describe("Where `pithy mcp serve` reads the workload token it presents per call.");
export type WorkloadTokenSource = z.infer<typeof WorkloadTokenSource>;

/**
 * `--oidc-token` as a source: `github`, `gitlab:<VARIABLE>`, or `env:<VARIABLE>`. Refused with the three
 * spellings named when it is none of them.
 */
export function parseTokenSource(raw: string): WorkloadTokenSource {
  const [kind, variable] = raw.split(":", 2);
  const parsed = WorkloadTokenSource.safeParse(kind === "github" ? { kind } : { kind, variable });
  if (parsed.success && (kind !== "github" || variable === undefined)) return parsed.data;
  throw new ValidationError({
    message: `--oidc-token takes github, gitlab:<VARIABLE> or env:<VARIABLE>, not ${raw}.`,
    action:
      "Pass --oidc-token github on GitHub Actions, --oidc-token gitlab:MCP_ID_TOKEN for the variable your id_tokens: block names, or --oidc-token env:<VARIABLE> for another issuer.",
  });
}

/** The source a known issuer implies, or `undefined` when the operator must name one. */
export function defaultTokenSource(issuer: string): WorkloadTokenSource | undefined {
  return issuer === "https://token.actions.githubusercontent.com" ? { kind: "github" } : undefined;
}

/** How a source reaches the outside world. Every term injected, so a test never reads a real runner. */
export interface WorkloadTokenSeams {
  /** The environment the variables are read from. */
  readonly env?: NodeJS.ProcessEnv;
  /** The fetch GitHub's request goes through. */
  readonly fetch?: typeof fetch;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
}

/** A token fetched less than this long before it expires is fetched again. */
const REFRESH_MARGIN_MS = 60_000;

/** The `exp` a JWT claims, in milliseconds, read without verifying — the Worker verifies; this only schedules. */
export function tokenExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** One fetch from a source, with nothing cached. */
async function fetchOnce(source: WorkloadTokenSource, audience: string, seams: WorkloadTokenSeams): Promise<string> {
  const env = seams.env ?? process.env;
  if (source.kind === "github") {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new PreconditionFailedError({
        message: "This job cannot request a GitHub identity token.",
        action: "Give the workflow `permissions: id-token: write`, and run the server inside that job.",
        detail: "ACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN is unset",
      });
    }
    const requested = new URL(url);
    requested.searchParams.set("audience", audience);
    const response = await (seams.fetch ?? fetch)(requested.toString(), {
      headers: { authorization: `bearer ${bearer}`, accept: "application/json" },
    });
    const body = (await response.json().catch(() => null)) as { value?: unknown } | null;
    if (!response.ok || typeof body?.value !== "string") {
      throw new UpstreamError({
        message: "GitHub did not issue an identity token.",
        action: "Check the workflow grants `id-token: write`, then run the job again.",
        detail: `token request answered ${response.status}`,
      });
    }
    return body.value;
  }
  const value = env[source.variable];
  if (!value) {
    throw new PreconditionFailedError({
      message: `${source.variable} holds no identity token.`,
      action:
        source.kind === "gitlab"
          ? `Name it in the job's id_tokens: block, with aud: ${audience}.`
          : `Export the workload's token as ${source.variable}, minted for ${audience}.`,
      detail: `${source.variable} is unset or empty`,
    });
  }
  return value;
}

/** A workload token, fetched on first use and again before it expires. */
export interface WorkloadTokens {
  /** The token to present on this call. */
  current(): Promise<string>;
}

/**
 * Tokens from one source, for one audience. Cached in memory until a minute before the `exp` the token claims; a
 * token that claims none is fetched again for every call, which costs a request and never presents a stale one.
 */
export function workloadTokens(
  source: WorkloadTokenSource,
  audience: string,
  seams: WorkloadTokenSeams = {},
): WorkloadTokens {
  const now = seams.now ?? (() => Date.now());
  let held: { token: string; expiresAt: number | null } | null = null;
  return {
    async current() {
      if (held !== null && held.expiresAt !== null && now() < held.expiresAt - REFRESH_MARGIN_MS) return held.token;
      const token = await fetchOnce(source, audience, seams);
      const expiresAt = tokenExpiry(token);
      if (expiresAt !== null && expiresAt <= now()) {
        // GitLab and a custom issuer mint once per job, so a token past its `exp` cannot be refreshed from here.
        throw new PreconditionFailedError({
          message: "The workload's identity token has expired.",
          action: "Run the job again; its token is minted when the job starts.",
          detail: `token from ${source.kind} expired at ${new Date(expiresAt).toISOString()}`,
        });
      }
      held = { token, expiresAt };
      return token;
    },
  };
}
