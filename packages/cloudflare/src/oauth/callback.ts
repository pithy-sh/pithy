// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/** What a callback said: a code to redeem, or Cloudflare's refusal. */
export type CallbackAnswer = { kind: "code"; code: string } | { kind: "error"; error: string; description: string };

/** What the address must match: the `state` and `redirect_uri` this sign-in sent. */
export interface CallbackExpectation {
  /** The `state` in the authorize URL. */
  state: string;
  /** The `redirect_uri` in the authorize URL, verbatim. */
  redirectUri: string;
}

/**
 * Read the address a browser landed on — from the loopback listener or pasted by hand — into an answer.
 *
 * **One reader for both paths, so they cannot check different things.** A remote session pastes what its
 * browser shows, because the redirect lands on the browser's own loopback interface, where nothing is
 * listening (measured over SSH, 2026-10-15). The pasted address is held to exactly what a delivered
 * callback is: the same origin and path this sign-in sent, the same `state`, and a `code` or an `error`.
 *
 * Accepting a paste is safe because of PKCE, not because of this check — a code is worthless without the
 * verifier, and the verifier never left this process. The `state` check is what stops a code from a
 * *different* sign-in being redeemed into this one.
 */
export function readCallback(address: string, expect: CallbackExpectation): CallbackAnswer {
  const text = address.trim().replace(/^["']|["']$/g, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw notTheAddress(expect, "it is not an address");
  }
  const sent = new URL(expect.redirectUri);
  if (url.origin !== sent.origin || url.pathname !== sent.pathname) {
    throw notTheAddress(expect, `it is ${url.origin}${url.pathname}`);
  }
  if (url.searchParams.get("state") !== expect.state) {
    throw new ValidationError({
      message: "That address belongs to a different sign-in: its state does not match.",
      action: `Paste the address from the browser tab this sign-in opened, or run ${commandName("cloudflare connect")} again.`,
      detail: "callback state did not match the state this sign-in sent",
    });
  }
  const error = url.searchParams.get("error");
  if (error !== null) {
    return { kind: "error", error, description: url.searchParams.get("error_description") ?? error };
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    throw new ValidationError({
      message: "That address carries no code and no error.",
      action: "Paste the whole address from the browser's address bar, after you approve.",
      detail: "callback had neither `code` nor `error`",
    });
  }
  return { kind: "code", code };
}

function notTheAddress(expect: CallbackExpectation, why: string): ValidationError {
  return new ValidationError({
    message: `That is not the address this sign-in sent the browser to: ${why}.`,
    action: `Paste the whole address your browser landed on. It starts with ${expect.redirectUri}.`,
    detail: `expected ${expect.redirectUri}`,
  });
}
