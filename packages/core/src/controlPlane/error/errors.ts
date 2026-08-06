// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "../../error/pithyError";

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
  message?: string;
  action?: string;
  detail?: string;
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
        action: args.action ?? "Run pithy dashboard connect --env <environment> to register one.",
        detail: args.detail,
      },
      options,
    );
  }
}

/**
 * The credential failed verification. One error for every step — pass the step in `detail` so the log
 * can say which, and the caller cannot.
 */
export class ControlPlaneInvalidCredentialError extends PithyError {
  constructor(args: ControlPlaneErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "controlplane/invalid_credential",
        status: 401,
        message: args.message ?? "That credential is not valid here.",
        action: args.action ?? "Rotate the connection's key, or re-run pithy dashboard connect --update.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** The credential verified, but nothing granted it this operation. */
export class ControlPlaneInsufficientScopeError extends PithyError {
  constructor(args: ControlPlaneErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "controlplane/insufficient_scope",
        status: 403,
        message: args.message ?? "This connection is not scoped for that operation.",
        action: args.action ?? "Re-run pithy dashboard connect --update and grant the scope this call needs.",
        detail: args.detail,
      },
      options,
    );
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
      },
      options,
    );
  }
}
