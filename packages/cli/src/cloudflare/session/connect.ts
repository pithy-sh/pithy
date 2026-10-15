// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type CallbackAnswer, readCallback } from "@pithy-sh/cloudflare/src/oauth/callback";
import {
  authorizeUrl,
  exchangeCode,
  type OAuthGrant,
  oauthState,
  pkcePair,
} from "@pithy-sh/cloudflare/src/oauth/client";
import { missingScopes, type SensitiveScope, sensitiveScopesIn } from "@pithy-sh/cloudflare/src/oauth/scopes";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { InputRequiredError, PithyError, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";

/**
 * How long a sign-in waits for the browser before giving up. Ten minutes: long enough to find the right
 * browser, sign in and read a consent screen; short enough that a forgotten terminal does not hold a
 * port open all afternoon.
 */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** A loopback listener waiting for the browser's redirect. */
export interface CallbackListener {
  /** `http://127.0.0.1:<port>/callback` — the `redirect_uri` the authorize URL carries. */
  redirectUri: string;
  /** The full address the browser was redirected to, once it arrives. */
  address: Promise<string>;
  /** Stop listening. Idempotent. */
  close(): void;
}

/**
 * **Listen for the redirect on `127.0.0.1`, on a port the OS chooses.**
 *
 * Cloudflare accepts any port on `127.0.0.1` for a loopback client, as RFC 8252 §7.3 requires, and holds
 * `localhost` to the exact registered port (both measured 2026-10-15). So port `0`: nothing can already
 * hold it, and no fixed number has to be kept clear of every developer's machine. IPv4 only, because the
 * address is an IPv4 literal — `localhost` would resolve, and could resolve to `::1` first.
 *
 * It answers one request to `/callback` and nothing else. The page it serves says only that the terminal
 * has what it needs; the code never appears in anything it renders.
 */
export function listenForCallback(accepts: (address: string) => boolean = () => true): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let deliver: (address: string) => void = () => {};
    const address = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    let answered = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || answered) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.\n");
        return;
      }
      const { port } = server.address() as AddressInfo;
      const delivered = `http://127.0.0.1:${port}${request.url ?? ""}`;
      // **Only this sign-in's redirect is taken.** A request with another `state` — a stray tab, a page that
      // guessed the port — is answered and ignored, so it cannot spend the one callback this run waits for.
      if (!accepts(delivered)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Not this sign-in.\n");
        return;
      }
      answered = true;
      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
        .end("Pithy has the sign-in. Return to the terminal; you can close this tab.\n");
      deliver(delivered);
    });
    server.once("error", rejectListener);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      let closed = false;
      resolveListener({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        address,
        close: () => {
          if (closed) return;
          closed = true;
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

/** What a sign-in asks for. */
export interface SignInRequest {
  /** The scopes to request — `sessionScopes(...)`, derived, never hand-listed. */
  scopes: readonly string[];
  /** Whether to open the browser. `--no-open` and `PITHY_NO_OPEN` say no; the URL is printed either way. */
  open: boolean;
  /** How long to wait. Defaults to {@link SIGN_IN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Where a sign-in talks to the person running it. */
export interface SignInIo {
  /** Write one line for the person. Under `--json` this is stderr, so stdout stays one document. */
  write(line: string): void;
  /** Open a URL in the browser. A rejection is reported in one line and the flow carries on. */
  open(url: string): Promise<void>;
  /**
   * Ask for the address the browser landed on. `null` is a cancel. Absent where nobody can type —
   * no terminal, or input forbidden — and then the callback is the only way in.
   */
  ask?: (signal: AbortSignal) => Promise<string | null>;
}

/** The two seams a test replaces: the listener and the token exchange. */
export interface SignInDeps {
  listen?: (accepts: (address: string) => boolean) => Promise<CallbackListener>;
  exchange?: (request: { code: string; verifier: string; redirectUri: string }) => Promise<OAuthGrant>;
}

/** "A, B and C", for naming scopes in a sentence. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The sentence that tells a person to switch the sensitive scopes on, in the consent screen's own words. */
function sensitiveInstruction(sensitive: readonly SensitiveScope[]): string {
  const names = listed(sensitive.map((scope) => scope.name));
  return `Cloudflare lists ${names} under "Sensitive scopes", switched off. Turn ${sensitive.length === 1 ? "it" : "each one"} on before you approve, or the sign-in fails.`;
}

/**
 * **What to do with the page that cannot be reached** — said before it happens, because it looks like a
 * failure. Over SSH the browser runs on another machine, Cloudflare redirects it to *that* machine's
 * `127.0.0.1`, and the browser shows "This site can't be reached". The sign-in has worked: the code is in
 * that page's address, and it redeems here. Every probe in #759 finished this way.
 */
export const PASTE_INSTRUCTION =
  "If the browser then shows a page that can't be reached, the sign-in still worked. Copy that page's whole address from the address bar and paste it here.";

/** A promise that never settles — what a canceled path contributes to a race it has dropped out of. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/**
 * **Sign in to Cloudflare in a browser: open the URL, and take whichever comes back first — the loopback
 * callback, or the address pasted by hand (#759).**
 *
 * Both, every time, because the remote case is common rather than an edge: over SSH the browser runs on
 * another machine, its redirect lands on *that* machine's loopback interface, and the code arrives only
 * if the person copies the address it shows. That code still redeems here, because the PKCE verifier
 * never left this process. Every probe in #759 was completed that way.
 *
 * In order: the URL is printed before anything else can fail; the sensitive scopes are named, because
 * approving with one switched off fails without a callback and with a message about the network; the
 * browser is opened unless asked not to; then the callback, the paste and the timeout race.
 *
 * The grant is checked against the request before it is returned. Cloudflare fails rather than granting
 * a subset today; a session missing `account-api-tokens.write` would otherwise fail at its first mint.
 */
export async function signIn(request: SignInRequest, io: SignInIo, deps: SignInDeps = {}): Promise<OAuthGrant> {
  const { verifier, challenge } = pkcePair();
  const state = oauthState();
  const listener = await (deps.listen ?? listenForCallback)(
    (address) => new URL(address).searchParams.get("state") === state,
  );
  const exchange = deps.exchange ?? exchangeCode;
  const expect = { state, redirectUri: listener.redirectUri };
  const url = authorizeUrl({ scopes: request.scopes, redirectUri: listener.redirectUri, state, challenge });
  const sensitive = sensitiveScopesIn(request.scopes);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    io.write("Sign in to Cloudflare:");
    io.write(`  ${url}`);
    if (sensitive.length > 0) io.write(sensitiveInstruction(sensitive));
    // After the address, never before it: both lines are about what happens once it has been opened.
    if (io.ask === undefined) io.write("Waiting for the browser. Pasting the address back needs a terminal.");
    else io.write(PASTE_INSTRUCTION);
    if (request.open) {
      await io.open(url).catch(() => io.write("Could not open a browser. Open the address above."));
    }

    const fromCallback = listener.address.then((address) => readCallback(address, expect));
    const fromPaste = io.ask === undefined ? never<CallbackAnswer>() : pasted(io.ask, expect, abort.signal, io.write);
    const timeoutMs = request.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(signInTimedOut(timeoutMs, sensitive)), timeoutMs);
    });
    const answer = await Promise.race([fromCallback, fromPaste, timedOut]);

    if (answer.kind === "error") {
      throw new PreconditionFailedError({
        message: `Cloudflare refused the sign-in: ${answer.description}`,
        action: `Run ${commandName("cloudflare connect")} again, and approve the request.`,
        detail: `authorize error ${answer.error}`,
      });
    }
    const grant = await exchange({ code: answer.code, verifier, redirectUri: listener.redirectUri });
    const missing = missingScopes(request.scopes, grant.scope);
    if (missing.length > 0) {
      const missingSensitive = sensitiveScopesIn(missing);
      throw new PreconditionFailedError({
        message: `Cloudflare granted the sign-in without ${listed(missing)}.`,
        action:
          missingSensitive.length > 0
            ? `Run ${commandName("cloudflare connect")} again. ${sensitiveInstruction(missingSensitive)}`
            : `Run ${commandName("cloudflare connect")} again, and approve every permission it asks for.`,
        detail: `requested ${request.scopes.join(" ")}; granted ${grant.scope}`,
      });
    }
    return grant;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
    listener.close();
  }
}

/**
 * Ask for the landing address until one is this sign-in's. A refused address is reported and asked
 * again — a paste of the wrong tab is a mistake to correct, not a reason to start over. A cancel ends
 * the sign-in; an abort (the callback won) drops this path out of the race.
 */
async function pasted(
  ask: (signal: AbortSignal) => Promise<string | null>,
  expect: { state: string; redirectUri: string },
  signal: AbortSignal,
  write: (line: string) => void,
): Promise<CallbackAnswer> {
  for (;;) {
    const text = await ask(signal);
    if (signal.aborted) return never();
    if (text === null) {
      throw new PreconditionFailedError({
        message: "Sign-in canceled.",
        action: `Run ${commandName("cloudflare connect")} when you are ready.`,
      });
    }
    try {
      return readCallback(text, expect);
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      write(error.payload.message);
    }
  }
}

/**
 * The sign-in nobody finished. A precondition, not an upstream timeout: Cloudflare answered every request
 * it was sent, and what did not arrive is the person's approval.
 */
function signInTimedOut(timeoutMs: number, sensitive: readonly SensitiveScope[]): PreconditionFailedError {
  const minutes = Math.round(timeoutMs / 60_000);
  return new PreconditionFailedError({
    message: `No sign-in arrived from the browser${minutes > 0 ? ` in ${minutes} minutes` : ""}.`,
    action:
      sensitive.length > 0
        ? `${sensitiveInstruction(sensitive)} Cloudflare reports that failure as a network problem. Run ${commandName("cloudflare connect")} again.`
        : `Run ${commandName("cloudflare connect")} again, and approve the request in the browser.`,
    detail: `no callback or pasted address within ${timeoutMs}ms`,
  });
}

/** One account the session can see. */
export interface SessionAccount {
  id: string;
  name: string;
}

/** What decides the account, in order of authority. */
export interface ChooseAccountOptions {
  /** The project's `cloudflare.accountId`. A pin the session cannot see is refused, never overridden. */
  pinned?: string;
  /** `--account <id>`. */
  requested?: string;
  /** Ask the person. Absent where nobody can answer. Returns the chosen id, or `null` for a cancel. */
  choose?: (accounts: readonly SessionAccount[]) => Promise<string | null>;
}

/**
 * **The account this session acts on — discovered, not stored by hand (#759).**
 *
 * The pin first, because the repository is the authority on which account it belongs to; then
 * `--account`; then the only account, when there is one; then the person, when they can be asked. Several
 * accounts and nothing to decide is refused with every id named, rather than guessed — guessing is how a
 * command reaches another company's tenant and exits 0.
 */
export async function chooseSessionAccount(
  accounts: readonly SessionAccount[],
  options: ChooseAccountOptions,
): Promise<SessionAccount> {
  if (accounts.length === 0) {
    throw new PreconditionFailedError({
      message: "The account you signed in as can see no Cloudflare account.",
      action: `Run ${commandName("cloudflare connect")} again as a member of the account this project uses.`,
    });
  }
  const byId = (id: string) => accounts.find((account) => account.id === id);
  if (options.pinned !== undefined) {
    const pinned = byId(options.pinned);
    if (pinned !== undefined) return pinned;
    throw new PreconditionFailedError({
      message: `This project pins Cloudflare account ${options.pinned}, and the account you signed in as cannot see it.`,
      action: `Run ${commandName("cloudflare connect")} again as a member of account ${options.pinned}.`,
      detail: `visible: ${accounts.map((account) => account.id).join(", ")}`,
    });
  }
  if (options.requested !== undefined) {
    const requested = byId(options.requested);
    if (requested !== undefined) return requested;
    throw new PreconditionFailedError({
      message: `The account you signed in as cannot see Cloudflare account ${options.requested}.`,
      action: `Pass --account with one of: ${accounts.map((account) => `${account.id} (${account.name})`).join(", ")}.`,
    });
  }
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only;
  if (options.choose !== undefined) {
    const chosen = await options.choose(accounts);
    const account = chosen === null ? undefined : byId(chosen);
    if (account !== undefined) return account;
    throw new PreconditionFailedError({ message: "No account chosen.", action: "Pass --account <id>." });
  }
  throw new InputRequiredError({
    message: `The account you signed in as can see ${accounts.length} Cloudflare accounts, and nothing says which one to use.`,
    action: `Pass --account with one of: ${accounts.map((account) => `${account.id} (${account.name})`).join(", ")}.`,
    flag: "--account",
    choices: accounts.map((account) => account.id),
  });
}
