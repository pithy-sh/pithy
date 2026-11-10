// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "./error/pithyError";

/**
 * Testing helpers for Workers-pool tests, published as `@pithy-sh/core/testing`.
 *
 * Nothing here belongs in a deployed Worker. Import it from test files and from the test doubles a test injects into
 * the code under test.
 */

/** How a {@link Gate} waits. */
export interface GateOptions {
  /** A label for the gate, named in the error a wait that runs out throws. */
  readonly name?: string;
  /** How often a waiting side checks whether the gate has opened, in milliseconds. Default 5. */
  readonly pollMs?: number;
  /**
   * How long a wait lasts before it throws, in milliseconds. Default 30 000. A step held past it fails rather than
   * holding its instance, and the test that forgot to open the gate, forever.
   */
  readonly timeoutMs?: number;
}

/** A flag one side opens and the other waits on, without either awaiting a promise the other settles. */
export interface Gate {
  /** Opens the gate. Every wait, current and later, gets through. Opening an open gate does nothing. */
  open(): void;
  /** Whether the gate has been opened. */
  readonly isOpen: boolean;
  /**
   * Resolves once the gate is open, checking on a timer of the caller's own.
   *
   * @throws InternalError when the gate stays closed for `timeoutMs`.
   */
  opened(): Promise<void>;
}

const DEFAULT_POLL_MS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A gate that holds a Workflow step at a chosen point until the test opens it, and that a test can wait on until a
 * step reaches one.
 *
 * A Workflow step and the test run in separate request contexts, and workerd can cancel a side that awaits a promise
 * the other settles as hung, after which disposing the instance's introspector hangs too. So the wait here never
 * awaits the other side: it polls a shared flag on a `setTimeout` in its own context. Reach the gate from the step
 * through a seam the test injects, such as a fetcher. `docs/WORKFLOW-TESTING.md` explains the hazard.
 *
 * ```ts
 * const held = createGate({ name: "first run held" });
 * const release = createGate({ name: "first run released" });
 * // In the injected fetcher the step calls:
 * held.open();
 * await release.opened();
 * // In the test:
 * await held.opened();
 * release.open();
 * ```
 */
export function createGate(options: GateOptions = {}): Gate {
  const name = options.name ?? "gate";
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(pollMs > 0)) throw new InternalError({ message: `A gate's pollMs must be a positive number, not ${pollMs}.` });
  if (!(timeoutMs > 0)) {
    throw new InternalError({ message: `A gate's timeoutMs must be a positive number, not ${timeoutMs}.` });
  }

  let isOpen = false;
  return {
    open() {
      isOpen = true;
    },
    get isOpen() {
      return isOpen;
    },
    async opened() {
      let waited = 0;
      while (!isOpen) {
        if (waited >= timeoutMs) {
          throw new InternalError({ message: `The ${name} stayed closed for ${timeoutMs}ms.` });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        waited += pollMs;
      }
    },
  };
}
