// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
import type { Capability } from "./capability";

/**
 * The composed set, reachable from module scope — **so a Workflow can find it** (pithy-sh/pithy#356).
 *
 * ## The gap this closes
 *
 * A capability's `compose` hook receives every other composed capability, so a route can hold
 * `@pithy-sh/email`'s bound `enqueue` and call it. `@pithy-sh/auth` does exactly that for magic links,
 * and an adopter copies the pattern for its own mail.
 *
 * **A Workflow class cannot.** The runtime constructs it with the worker `env` and nothing else. `env`
 * carries `DB`, `EMAIL_SENDER` and every other binding, but a composed seam is a closure `compose`
 * handed out, not a binding — and there was no way back from a durable step to the composed set. The
 * two ways past it were both wrong and both the adopter's to take: rebuild the seam from `env` plus a
 * restated identity (the same sending address in a second place, free to drift from `pithy.config.ts`),
 * or pass the closure through Workflow params (which are serialised, and a closure is not). So a durable
 * job could never send mail, and `pithy-sh/dashboard`'s monthly key-rotation notice was written, tested,
 * and reachable by nothing.
 *
 * ## Why module scope is the right place, and what it costs
 *
 * `createBackend` runs at module load, and Cloudflare requires a Workflow class to be exported from the
 * same worker entrypoint that exports the `fetch` handler — so the composition has already happened, in
 * this isolate, by the time any step body runs. That is the same reasoning
 * `@pithy-sh/secrets`' shared accessor is built on, and it is worth being explicit that it is a
 * *reasoned* singleton rather than a convenient global: one worker assembles one backend.
 *
 * The cost is that a second `createBackend` in one isolate replaces the first. In a deployed Worker that
 * cannot happen; in a test file it can, so {@link recordComposition} replaces wholesale rather than
 * merging — a half-remembered composition would be worse than none — and {@link forgetComposition}
 * exists so a suite can return to the un-composed state and assert what happens there.
 *
 * **Nothing here is a service locator for application code.** A route has `c.var`, and a capability has
 * its `compose` hook; both are better, both are typed, and both stay the way to reach a seam. This is
 * for the one caller that has neither.
 */

/** The composed set, or null before any backend has been assembled in this isolate. */
let composed: readonly Capability[] | null = null;

/**
 * Record the composed set. Called once by `createBackend`, after every `compose` hook has run — so a
 * capability found here is one whose own wiring is already complete, not one mid-assembly.
 */
export function recordComposition(capabilities: readonly Capability[]): void {
  composed = [...capabilities];
}

/** Forget it. For a test that needs the un-composed state back; a deployed Worker never calls this. */
export function forgetComposition(): void {
  composed = null;
}

/**
 * The composed capabilities, or a raised wiring fault.
 *
 * Empty is not an answer. A caller asking this has already decided it needs a composed seam, and an
 * empty array would send it down a "the capability is not composed" path that is indistinguishable from
 * "no backend was assembled" — two very different things to tell somebody reading a log at 3am.
 */
export function composedCapabilities(): readonly Capability[] {
  if (composed === null) {
    throw new InternalError({
      message: "This job could not reach the application's capabilities.",
      action: "Export the Workflow class from the same worker entrypoint that calls createBackend.",
      detail: "composedCapabilities() was called before any createBackend ran in this isolate.",
    });
  }
  return composed;
}

/**
 * One composed capability by name, narrowed by its own type guard, or a raised wiring fault naming it.
 *
 * The guard is the capability's own (`isEmailCapability`, and its peers), so the narrowing is the
 * capability's declaration rather than a cast here — a capability composed under the right name but
 * without its seams attached is caught as the wiring failure it is, not returned as something whose
 * methods are missing at the call site.
 */
export function composedCapability<T extends Capability>(name: string, is: (capability: Capability) => boolean): T {
  const found = composedCapabilities().find((capability) => capability.name === name && is(capability));
  if (!found) {
    throw new InternalError({
      // The capability's name is in the client-safe half deliberately, exactly as `createBackend`'s
      // missing-peer check names it: a capability name is a published part of this framework, and a
      // wiring fault that will not say which wire is a fault nobody can act on.
      message: `The "${name}" capability is not composed, so this job could not run.`,
      action: `Add ${name}(...) to createBackend's capabilities (run \`pithy add ${name}\`).`,
      detail: `no composed capability named "${name}" carrying its seams was found.`,
    });
  }
  return found as T;
}
