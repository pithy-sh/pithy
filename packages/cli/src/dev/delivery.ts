// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { resolveCloudflare } from "../cloudflare/config";
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

/**
 * Whether Cloudflare credentials resolve at all — the cheap half of the delivery preflight.
 *
 * No network call and no account probe: it reads the file this project's own account selection points
 * at, overlaid with the environment, exactly as every other command does. That is enough to catch the
 * state a developer most often starts in, at none of the cost of asking Cloudflare.
 *
 * Here rather than in the dev command because `pithy dev` and `pithy doctor` both ask it, and they must
 * not come to two answers about one machine.
 */
export async function hasCloudflareLogin(projectDir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const vars = resolveCloudflare({ account: await projectCloudflareAccount(projectDir), env }).vars;
    return Boolean(vars.CLOUDFLARE_ACCOUNT_ID && vars.CLOUDFLARE_API_TOKEN);
  } catch {
    return false;
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
  /** Whether Cloudflare credentials resolved at all. `false` means `wrangler dev` has no login to use. */
  hasCloudflareLogin: boolean;
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

  if (!options.hasCloudflareLogin) {
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

  return { live: true, lines: [`Email: sending for real from ${options.fromAddress}.`] };
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
