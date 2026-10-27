// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "../../cli/command";
import { PithyError } from "../../error/pithyError";
import type { MessageParams } from "../../i18n/catalog";
import type { UnmarkedString } from "../../privacy/types";
import type { ControlPlaneActorKind } from "../data/connection";

/**
 * The `control-plane` strategy's throw sugar. The `controlplane/*` codes live in core's closed
 * `KitErrorPayload` union (CLAUDE.md §Errors); these subclasses are the vehicles that set one.
 *
 * The security posture here is stricter than elsewhere in the tree. Public `message` and `action` are
 * written for an operator reading a management client's logs, and say nothing a caller could use to
 * probe the seam. Throw-site context — which verification step failed, which `kid` was presented,
 * which environment the connection is bound to — goes in `detail`, which the HTTP codec strips.
 *
 * {@link ControlPlaneInvalidCredentialError} in particular is deliberately one error for every
 * failing step. Distinguishing "unknown key" from "bad signature" from "replayed token" would turn
 * the response into an oracle that tells an attacker exactly how far they got.
 */

interface ControlPlaneErrorArgs {
  message?: UnmarkedString;
  action?: UnmarkedString;
  detail?: UnmarkedString;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/**
 * No connection is registered for this environment. The shipped default of a Worker that composes the
 * seam and has never been connected — present, and denying everything.
 */
export class ControlPlaneNotConnectedError extends PithyError {
  constructor(args: ControlPlaneErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "controlplane/not_connected",
        status: 403,
        message: args.message ?? "No management client is connected to this environment.",
        action:
          args.action ??
          `Register one for this environment with ${commandName("dashboard connect")}, naming it with --env.`,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * What a call under an OIDC trust carried when its claims did not match (#722), for the audit row and nobody
 * else.
 *
 * Set only once the token's signature, issuer and audience have verified: by then the caller demonstrably
 * holds a genuine token for this audience, so naming the claims it sent leaks nothing it does not already
 * hold — and those claims are what an operator picks a matcher from. Before that the single-error discipline
 * holds, and no refusal carries this.
 */
export interface ControlPlaneRefusedTrust {
  /** The connection whose trust was named. */
  readonly connectionId: string;
  /** The trust the call named. */
  readonly trustId: string;
  /** The workload's claims, as strings, capped — `observedClaims` in `../data/oidcTrust`. */
  readonly observedClaims: Readonly<Record<string, string>>;
}

/**
 * The credential failed verification. One error for every step — pass the step in `detail` so the log
 * can say which, and the caller cannot.
 */
export class ControlPlaneInvalidCredentialError extends PithyError {
  /**
   * A claim mismatch on an otherwise verified OIDC token, for the denial row. A property of the vehicle, never of
   * `payload`, so the refusal a caller receives is the same one every other step answers. Null everywhere else.
   */
  readonly refusedTrust: ControlPlaneRefusedTrust | null;

  constructor(
    args: ControlPlaneErrorArgs & { refusedTrust?: ControlPlaneRefusedTrust } = {},
    options?: { cause?: unknown },
  ) {
    super(
      {
        code: "controlplane/invalid_credential",
        status: 401,
        message: args.message ?? "That credential is not valid here.",
        action:
          args.action ??
          `Rotate the connection's key, or update this environment's connection with ${commandName("dashboard connect")} and its --update flag.`,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
    this.refusedTrust = args.refusedTrust ?? null;
  }
}

/**
 * Who a scope refusal refused, as verification proved it (#812).
 *
 * By the scope step the signature, the key, the lifetime and the body digest have all verified, so these are facts
 * rather than claims. The gate writes them onto the denial row, which is what lets a known credential probing
 * for scopes it lacks be traced back to it.
 */
export interface ControlPlaneRefusedCaller {
  /** The connection the verified token addressed. */
  readonly connectionId: string;
  /** The token's `sub`, proven by the signature. */
  readonly subject: string;
  /** The registered key that verified the signature — or, for a call under an OIDC trust, the trust. */
  readonly keyId: string;
  /**
   * Said only for a call under an OIDC trust (#722), in which case `keyId` names the trust. Absent reads as a key, as
   * it does on the allowed row, so a trust's refusals are not recorded as a key's with an id no key has.
   */
  readonly credentialKind?: "trust";
  /**
   * The kind of client the connection was registered as, from the adopter's row and never the token — the same value
   * the allowed row is stamped with, so a trail filtered on kind holds a client's refusals beside its calls. Null for a
   * connection registered before kinds were recorded.
   */
  readonly actorKind: ControlPlaneActorKind | null;
}

/** The credential verified, but nothing granted it this operation. */
export class ControlPlaneInsufficientScopeError extends PithyError {
  /**
   * The verified caller, for the audit row and nobody else. A property of the vehicle, never of `payload`: the HTTP
   * codec encodes the payload alone, so the refusal a caller receives is unchanged. Null when a throw site has no
   * verified caller to name.
   */
  readonly caller: ControlPlaneRefusedCaller | null;

  constructor(
    args: ControlPlaneErrorArgs & { caller?: ControlPlaneRefusedCaller } = {},
    options?: { cause?: unknown },
  ) {
    super(
      {
        code: "controlplane/insufficient_scope",
        status: 403,
        message: args.message ?? "This connection is not scoped for that operation.",
        action:
          args.action ??
          `Update this environment's connection with ${commandName("dashboard connect")} and its --update flag, granting the scope this call needs.`,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
    this.caller = args.caller ?? null;
  }
}

/** The named key is not registered on this connection. */
export class ControlPlaneKeyNotFoundError extends PithyError {
  constructor(args: ControlPlaneErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "controlplane/key_not_found",
        status: 404,
        message: args.message ?? "No registered key answers to that key id.",
        action: args.action ?? "Read GET /control-plane/keys for the keys this connection currently trusts.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A key operation conflicts with the connection's current state — a duplicate registration, or an
 * expiry that would leave no live key. The second is the lockout case, and refusing it is the reason
 * expiry is a separate call from registration.
 */
export class ControlPlaneKeyConflictError extends PithyError {
  constructor(args: ControlPlaneErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "controlplane/key_conflict",
        status: 409,
        message: args.message ?? "That key operation conflicts with the connection's current state.",
        action: args.action ?? "Register the replacement key and prove it with a ping before expiring this one.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
