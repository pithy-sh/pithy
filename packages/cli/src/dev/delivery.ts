// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { cloudflareChildEnv, overriddenCredentialKeys } from "../cloudflare/childEnv";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { projectCloudflareAccount } from "../project/config";

/**
 * **Real mail from a laptop, and what happens when it cannot be.**
 *
 * `pithy dev` runs each composed capability's host Worker, and email's host carries the one binding in
 * the kit that puts a message on the wire. `remote: true` on that binding runs the Worker locally and
 * delivers through Cloudflare Email Service for real — the same pipeline, the same DKIM, the same
 * delivery logs as production — which is what makes a magic link triggered from localhost actually
 * arrive (pithy-sh/pithy#410).
 *
 * That depends on two things the kit does not own: a Cloudflare login `wrangler dev` can use, and a
 * sending domain already onboarded onto Email Service. The requirement is not that both always hold.
 * It is that **no path from here ends in silence** — because silence is the defect this whole issue is
 * about, and a developer waiting on an inbox is the worst possible place to discover a missing login.
 *
 * So there are two checks, and they are deliberately different in kind:
 *
 * - {@link deliveryPreflight} runs **before anything spawns**, costs nothing, and *decides*. A check
 *   that runs first is worth more than a message that arrives second: where it can already see that
 *   real delivery is impossible, the host is resolved with the simulator instead and the banner says
 *   so once. The session is correct either way.
 * - {@link deliveryFailureNote} runs over the host's own output and *reports*. The preflight is cheap,
 *   which is another way of saying it is not the guarantee: a remote binding is established when the
 *   Worker starts, and a domain that is not onboarded most likely fails there — or at the first send.
 *   Either shape is caught where it appears and rendered as a `PithyError` with the action that fixes
 *   it, rather than scrolling past as somebody else's stack trace.
 *
 * Neither path kills the session. `pithy dev` supervises Workers; a message that did not send is a
 * reason for a sentence, not for tearing down every process a developer is working in.
 */

/** Which Cloudflare account the workers of this session will authenticate as, and whether they can. */
export interface ChildCloudflareIdentity {
  /** The account id in the child environment, or `null` when it carries none. */
  accountId: string | null;
  /** Whether that environment also carries a token. Both halves or neither — see {@link deliveryPreflight}. */
  hasToken: boolean;
  /**
   * The sentence for a pin the credentials contradict, or `null` when there is no disagreement.
   *
   * **A third state, because two could not say this and both said something false.** `pithy dev` refuses
   * outright on a mismatch, so it never reaches the preflight — but `pithy doctor` reports rather than
   * refuses, and with only `accountId`/`hasToken` to answer with it had to pick a lie: the resolution
   * before #555 was non-throwing, so a mismatch read as credentials *present* and doctor announced
   * `sending for real` about an account the repository disowns; resolving through `cloudflareEnv` instead
   * makes it read as credentials *absent*, and doctor says `run: pithy init` — which is not the fix and
   * would not help anyone who ran it. The remedy is one line of `pithy.config.ts`, so the state that
   * names it has to exist.
   */
  mismatch: string | null;
}

/**
 * What the workers this session spawns will authenticate to Cloudflare as — **read off the environment
 * they are actually handed.**
 *
 * **The preflight used to answer a different question than the one it was asked, and that is #555's
 * second half.** It resolved the *project's* credentials, found them present, and printed `Email: sending
 * for real from noreply@pithy.sh.` — then the orchestrator spawned workers carrying the *shell's*
 * credentials, because nothing overlaid the resolved pair onto the child environment. The check was not
 * wrong about what it looked at. It was looking at the wrong thing, which is why a confident banner was
 * followed by five silent failures.
 *
 * So it takes the child environment itself. There is no second resolution to agree or disagree with: the
 * map this reads is the map handed to `spawn`, so the account named in the banner and the account the
 * mail leaves through are one fact by construction.
 *
 * Blank is unset, exactly as the credential overlay reads it, so a `CLOUDFLARE_API_TOKEN=""` from a
 * guarded test environment is no token rather than an empty one.
 *
 * Here rather than in the dev command because `pithy dev` and `pithy doctor` both ask it, and they must
 * not come to two answers about one machine.
 */
export function childCloudflareIdentity(env: Readonly<Record<string, string | undefined>>): ChildCloudflareIdentity {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  return {
    accountId: accountId ? accountId : null,
    hasToken: Boolean(env.CLOUDFLARE_API_TOKEN),
    // An environment that resolved is an environment with no disagreement left in it: `cloudflareEnv`
    // throws on a mismatch rather than returning one, so reaching here at all settles it.
    mismatch: null,
  };
}

/**
 * The environment every worker of this session inherits, credentialed for the project's account — and the
 * identity read back off it.
 *
 * One call, two consumers: the orchestrator spawns with `env` and the preflight decides on `identity`.
 * That is the invariant this module exists to hold — see {@link childCloudflareIdentity}.
 *
 * `overridden` names the credential keys the project's resolution replaced on the way in, for the line
 * that tells a developer `wrangler whoami` is about to disagree with every Worker `pithy dev` starts.
 */
export interface DevCloudflareEnv {
  /** The child environment, from `cloudflareChildEnv`. Hand this to `spawn`, unaltered. */
  env: Record<string, string>;
  /** What those children authenticate as. */
  identity: ChildCloudflareIdentity;
  /** Credential keys the shell had exported and the project's resolution replaced. Usually empty. */
  overridden: readonly string[];
}

/**
 * Build that environment for one dev session.
 *
 * A pinned `cloudflare.accountId` the credentials contradict throws out of here — `cloudflareChildEnv`'s
 * refusal, which is #206's — and it throws **before any worker spawns**, which is the point: a disowned
 * account discovered by five failed sends is the incident.
 */
export function devCloudflareEnv(
  account: CloudflareAccountSelection | null,
  base: NodeJS.ProcessEnv,
): DevCloudflareEnv {
  const env = cloudflareChildEnv({ account, base });
  return { env, identity: childCloudflareIdentity(env), overridden: overriddenCredentialKeys(base, env) };
}

/**
 * The project's Cloudflare account for a dev session — **`null` where there is no project config, and a
 * refusal where there is one that will not load.**
 *
 * The distinction is the whole function. `pithy dev` has always tolerated a missing root
 * `pithy.config.ts`: `devSet`'s `defaultProjectName` catches and degrades to "no capability host can be
 * named", and the session still starts every `apps/*`. Moving the account resolution up to the command
 * put a `loadProject` in front of that, and a bare `await projectCloudflareAccount(projectDir)` would
 * have made a config-less project stop starting at all.
 *
 * But it may not swallow more than absence. A root config that *exists* and fails to load — an invalid
 * `cloudflare.accountName`, a config that default-exports the wrong shape — would degrade to `null`,
 * and `null` does not mean "no account": it selects the **default** `<config>/cloudflare.json`. On a
 * machine with two accounts that is another tenant's credentials, chosen because a config file had a
 * typo in it. So absence is `null` and everything else is raised, which is `readOptionalWranglerConfig`'s
 * rule — absent is ENOENT and nothing else — applied one layer up.
 */
export async function devCloudflareAccount(projectDir: string): Promise<CloudflareAccountSelection | null> {
  try {
    return await projectCloudflareAccount(projectDir);
  } catch (error) {
    if (error instanceof PithyError && error.payload.code === "core/not_found") return null;
    throw error;
  }
}

/**
 * The same, for `pithy doctor`, which reports on a machine rather than spawning on it.
 *
 * It loads the account itself — doctor has no dev session to have resolved one — and answers `null`
 * credentials rather than throwing, because a mismatch is a line in that report and not the end of it.
 */
export async function projectChildCloudflareIdentity(
  projectDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildCloudflareIdentity> {
  try {
    const account = await devCloudflareAccount(projectDir);
    return childCloudflareIdentity(devCloudflareEnv(account, env).env);
  } catch (error) {
    // A contradicted pin is reported as itself. Everything else — no project, an unreadable credentials
    // file — is the unconfigured case, which the `pithy init` line already answers correctly.
    const mismatch =
      error instanceof PithyError && error.payload.code === "core/conflict" ? error.payload.message : null;
    return { accountId: null, hasToken: false, mismatch };
  }
}

/** What the preflight was asked to check, and what it had to check with. */
export interface DeliveryPreflightOptions {
  /** Whether the project composes email at all. Nothing to check when it does not. */
  composed: boolean;
  /** The delivery mode the adopter's config selected — `simulator` is a deliberate choice, not a failure. */
  requested: "remote" | "simulator";
  /** The from address the capability sends as; its domain is what must be onboarded. */
  fromAddress?: string;
  /**
   * What the workers this session spawns will authenticate as — from {@link childCloudflareIdentity},
   * read off the environment they are handed rather than resolved a second time (#555).
   */
  cloudflare: ChildCloudflareIdentity;
}

/** The preflight's answer: what this session will do about delivery, and the lines that say so. */
export interface DeliveryPreflight {
  /** Whether the email host is resolved for real delivery. `false` selects the local simulator. */
  live: boolean;
  /** Terminal lines — a problem and its action, or the one line that states a deliberate choice. */
  lines: string[];
}

/** Domains that cannot be onboarded onto Email Service, so a from address on one can never deliver. */
const UNDELIVERABLE_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost", "test", "invalid"]);

/** The domain half of an address, lowercased, or `undefined` when the address has no usable one. */
function domainOf(address: string | undefined): string | undefined {
  const at = address?.lastIndexOf("@") ?? -1;
  if (at < 0 || address === undefined) return undefined;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain === "" ? undefined : domain;
}

/**
 * Decide, before anything spawns, whether this session sends real mail — and say why when it does not.
 *
 * Cheap by construction: no network call, no account lookup. It reads the credentials that already
 * resolved and the address the capability is configured to send as. That catches the two states a
 * developer most often starts a session in — no Cloudflare login at all, and a placeholder from
 * address nobody has replaced — which is most of the value, at none of the cost of asking Cloudflare.
 */
export function deliveryPreflight(options: DeliveryPreflightOptions): DeliveryPreflight {
  if (!options.composed) return { live: false, lines: [] };

  if (options.requested === "simulator") {
    return {
      live: false,
      lines: ["Email: the simulator, by config. Messages are logged and written to disk, never sent."],
    };
  }

  // Before the unconfigured branch, because a mismatch is not an absence and `pithy init` is not its fix.
  // The sentence is `describeCloudflareAccountMismatch`'s, reused rather than spelled a second time — two
  // wordings for one diagnosis is how they drift.
  if (options.cloudflare.mismatch) {
    return {
      live: false,
      lines: [
        `Email: ${options.cloudflare.mismatch} Real delivery is not possible here — using the simulator.`,
        "  set `cloudflare.accountId` in pithy.config.ts to the account this project belongs to, or `cloudflare.accountName` to the file holding its credentials.",
      ],
    };
  }

  // Both halves or neither. An account id with no token cannot authenticate and a token with no account
  // id has nothing to authenticate against, so either alone is the `pithy init` case.
  if (!options.cloudflare.accountId || !options.cloudflare.hasToken) {
    return {
      live: false,
      lines: [
        "Email: no Cloudflare credentials, so real delivery is not possible here — using the simulator.",
        "  run: pithy init, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
      ],
    };
  }

  const domain = domainOf(options.fromAddress);
  if (domain === undefined || UNDELIVERABLE_DOMAINS.has(domain)) {
    return {
      live: false,
      lines: [
        `Email: ${options.fromAddress ?? "no from address"} cannot be onboarded onto Email Service — using the simulator.`,
        "  set email({ fromAddress }) to an address on a domain you have onboarded.",
      ],
    };
  }

  // The account is named, and that is #555 in one line: a developer whose shell holds a second account's
  // token could read `wrangler whoami`, read `pithy doctor`, and still not know which one a send from
  // this session would use. The banner is where that stops being a deduction.
  return {
    live: true,
    lines: [
      `Email: sending for real from ${options.fromAddress}, as Cloudflare account ${options.cloudflare.accountId}.`,
    ],
  };
}

/**
 * What the host says when a remote `send_email` binding will not stand up, or a send is rejected.
 *
 * Matched narrowly and on purpose. These are wrangler's and Cloudflare's words, not ours, so this is
 * pattern matching over somebody else's output and the failure mode of being too clever is a false
 * accusation on an unrelated line. Two shapes only — a binding that could not be established, and a
 * send refused for an address or domain that is not onboarded — and anything else falls through to
 * the ordinary tee'd output, where it is at least visible.
 */
const DELIVERY_FAILURES: readonly { pattern: RegExp; message: string; action: string }[] = [
  {
    pattern: /remote binding.*(send_email|EMAIL)|(send_email|EMAIL).*remote binding/i,
    message: "The email host's send binding could not be established, so nothing will be delivered.",
    action: 'Check the Cloudflare login wrangler dev uses, or set email({ devDelivery: "simulator" }).',
  },
  {
    pattern:
      /(sender|from address|domain).*(not (a )?verified|unverified|not onboarded)|(not (a )?verified|unverified|not onboarded).*(sender|address|domain)/i,
    message: "Cloudflare Email Service refused the sending address — its domain is not onboarded.",
    action: 'Onboard the domain onto Email Service, or set email({ devDelivery: "simulator" }).',
  },
];

/**
 * A rendered problem + action block for a host output line that reports a delivery failure, or
 * `undefined` for every other line. Rendered through `renderTerminal` so it reads exactly like every
 * other operator-facing failure, rather than being a second error format nobody recognizes.
 */
export function deliveryFailureNote(line: string): string | undefined {
  const match = DELIVERY_FAILURES.find((failure) => failure.pattern.test(line));
  if (!match) return undefined;
  return renderTerminal(
    new PithyError({
      code: "core/upstream_failed",
      status: 502,
      message: match.message,
      action: match.action,
      detail: line,
    }).payload,
  );
}
