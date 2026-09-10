// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import type { ManagedEnvironment } from "../scope";
import {
  backendRoutedDispatcher,
  dispatchSecretWrite,
  environmentsWrittenBeforeFailure,
  type PreflightSecretDispatcher,
  type SecretDispatcher,
  type SecretWrite,
  type SecretWriteRequest,
  withoutPreflight,
} from "./dispatch";

class StubDispatcher implements PreflightSecretDispatcher {
  readonly calls: SecretWriteRequest[] = [];
  /** What the pre-flight was asked, kept apart from what was written — asking is not writing. */
  readonly asked: SecretWriteRequest[] = [];
  async dispatch(request: SecretWriteRequest): Promise<void> {
    this.calls.push(request);
  }
  async preflight(request: SecretWriteRequest): Promise<void> {
    this.asked.push(request);
  }
}

/**
 * A dispatcher that keeps its own store, so what a test asserts about a run is checked against what the
 * managers hold rather than against the value the run returned. It fails on one named environment, the
 * way an intermittent fault would.
 */
class FaultyDispatcher implements SecretDispatcher {
  readonly held = new Map<ManagedEnvironment, string>();
  constructor(private readonly failsOn: ManagedEnvironment) {}
  async dispatch(request: SecretWriteRequest): Promise<void> {
    if (request.env === this.failsOn) throw new Error(`D1_ERROR: storage caused object to be reset in ${request.env}`);
    this.held.set(request.env, request.value ?? "");
  }
}

const base: Omit<SecretWrite, "backend" | "scope"> = {
  mode: "create",
  name: "api-token",
  bootstrap: false,
  rotatable: false,
  valueType: "text",
  value: "v",
  requested: "staging",
};

/** A global write as an operator who did not narrow it issues one. */
const globalWrite: Omit<SecretWrite, "backend" | "scope"> = { ...base, requested: undefined };

describe("dispatchSecretWrite", () => {
  test("an environment-scoped write dispatches to exactly the requested env", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(
      dispatcher,
      { ...base, backend: "d1", scope: "environment" },
      DEFAULT_ENVIRONMENTS,
    );

    expect(targets).toEqual(["staging"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["staging"]);
    expect(dispatcher.calls[0]).toMatchObject({ mode: "create", name: "api-token", value: "v" });
  });

  test("a global d1 write fans out to both managers", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(
      dispatcher,
      { ...globalWrite, backend: "d1", scope: "global" },
      DEFAULT_ENVIRONMENTS,
    );

    expect(targets).toEqual(["staging", "prod"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["staging", "prod"]);
  });

  test("a global cf-secrets-store write goes to the canonical env only", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(
      dispatcher,
      { ...globalWrite, backend: "cf-secrets-store", scope: "global" },
      DEFAULT_ENVIRONMENTS,
    );

    expect(targets).toEqual(["prod"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["prod"]);
  });

  test("a global write follows the project's own declaration, not a hardcoded pair", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(dispatcher, { ...globalWrite, backend: "d1", scope: "global" }, [
      "staging",
      "live",
    ]);

    // The `live` gap, closed: a shared secret reaches every environment the project deploys to.
    expect(targets).toEqual(["staging", "live"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["staging", "live"]);
  });

  test("a delete dispatches with no value", async () => {
    const dispatcher = new StubDispatcher();
    await dispatchSecretWrite(
      dispatcher,
      {
        mode: "delete",
        name: "api-token",
        backend: "d1",
        scope: "environment",
        bootstrap: false,
        rotatable: false,
        valueType: "text",
        requested: "prod",
      },
      DEFAULT_ENVIRONMENTS,
    );

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({ env: "prod", mode: "delete", name: "api-token" });
    expect(dispatcher.calls[0]?.value).toBeUndefined();
  });
});

describe("dispatchSecretWrite — a narrowed global write is refused before anything is sent", () => {
  test("every mode refuses, and the dispatcher is never called", async () => {
    const modes = ["create", "update", "delete"] as const;
    expect(modes).toHaveLength(3);
    for (const mode of modes) {
      const dispatcher = new StubDispatcher();
      await expect(
        dispatchSecretWrite(dispatcher, { ...base, mode, backend: "d1", scope: "global" }, DEFAULT_ENVIRONMENTS),
      ).rejects.toThrow(PithyError);
      // A refusal that has already written is not a refusal. No Workflow is started on this path.
      expect(dispatcher.calls, mode).toEqual([]);
    }
  });

  test("the refusal carries no report, because nothing was written", async () => {
    const dispatcher = new StubDispatcher();
    const error = await dispatchSecretWrite(
      dispatcher,
      { ...base, backend: "d1", scope: "global" },
      DEFAULT_ENVIRONMENTS,
    ).catch((thrown: unknown) => thrown);

    expect(environmentsWrittenBeforeFailure(error)).toEqual([]);
  });

  test("an environment-scoped write with no environment refuses rather than guessing one", async () => {
    const dispatcher = new StubDispatcher();
    await expect(
      dispatchSecretWrite(dispatcher, { ...globalWrite, backend: "d1", scope: "environment" }, DEFAULT_ENVIRONMENTS),
    ).rejects.toThrow(PithyError);
    expect(dispatcher.calls).toEqual([]);
  });
});

describe("dispatchSecretWrite — a fan-out that dies part-way says what it wrote", () => {
  const declared = ["staging", "canary", "prod"];

  test("the environments it reached are named, and the ones it missed are not", async () => {
    const dispatcher = new FaultyDispatcher("prod");
    const error = await dispatchSecretWrite(
      dispatcher,
      { ...globalWrite, backend: "d1", scope: "global", value: "new" },
      declared,
    ).catch((thrown: unknown) => thrown);

    const written = environmentsWrittenBeforeFailure(error);
    // Checked against the managers' own store, not against the value the run produced.
    expect([...dispatcher.held.keys()]).toEqual(["staging", "canary"]);
    expect(written).toEqual([...dispatcher.held.keys()]);
    expect(written).not.toContain("prod");
  });

  test("the fault it reports is the fault that happened, unchanged", async () => {
    const dispatcher = new FaultyDispatcher("canary");
    const error = await dispatchSecretWrite(
      dispatcher,
      { ...globalWrite, backend: "d1", scope: "global" },
      declared,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("storage caused object to be reset in canary");
    expect(environmentsWrittenBeforeFailure(error)).toEqual(["staging"]);
  });

  test("a fault on the first environment reports nothing written, and that is true", async () => {
    const dispatcher = new FaultyDispatcher("staging");
    const error = await dispatchSecretWrite(
      dispatcher,
      { ...globalWrite, backend: "d1", scope: "global" },
      declared,
    ).catch((thrown: unknown) => thrown);

    expect([...dispatcher.held.keys()]).toEqual([]);
    expect(environmentsWrittenBeforeFailure(error)).toEqual([]);
  });

  test("a throw from anywhere else carries no report at all", () => {
    expect(environmentsWrittenBeforeFailure(new Error("unrelated"))).toEqual([]);
    expect(environmentsWrittenBeforeFailure(undefined)).toEqual([]);
    expect(environmentsWrittenBeforeFailure("a string")).toEqual([]);
  });

  test("a run that finishes returns what landed, environment by environment", async () => {
    const dispatcher = new FaultyDispatcher("nowhere");
    const targets = await dispatchSecretWrite(dispatcher, { ...globalWrite, backend: "d1", scope: "global" }, declared);

    expect(targets).toEqual([...dispatcher.held.keys()]);
    expect(targets).toEqual(declared);
  });
});

/**
 * **The request states its destination, and one object turns that into a writer** (#517).
 *
 * Before this, every request reached the manager write-Workflow, which reaches one environment's D1 —
 * so a `cf-secrets-store` secret's value was encrypted into a row nothing reads, and the command that
 * did it exited 0. Nothing downstream could route, because nothing upstream said where the value
 * belonged.
 */
describe("backendRoutedDispatcher", () => {
  const write: SecretWrite = {
    mode: "create",
    name: "SUPPLIED",
    backend: "cf-secrets-store",
    scope: "environment",
    bootstrap: false,
    rotatable: false,
    valueType: "text",
    value: "v",
    requested: "staging",
  };

  test("a write goes to the backend its registry entry declares, and to no other", async () => {
    const d1 = new StubDispatcher();
    const store = new StubDispatcher();
    const routed = backendRoutedDispatcher({ d1, "cf-secrets-store": store });

    await dispatchSecretWrite(routed, write, DEFAULT_ENVIRONMENTS);
    expect(store.calls.map((call) => call.name)).toEqual(["SUPPLIED"]);
    expect(d1.calls).toEqual([]);

    await dispatchSecretWrite(routed, { ...write, name: "ROW", backend: "d1" }, DEFAULT_ENVIRONMENTS);
    expect(d1.calls.map((call) => call.name)).toEqual(["ROW"]);
    expect(store.calls.map((call) => call.name)).toEqual(["SUPPLIED"]);
  });

  /**
   * The registry's two routing facts reach the writer intact. `backend` picks it; `scope` is what a store
   * writer composes the entry name from, and a `global` secret resolves to one account-level entry rather
   * than to a per-environment one — so a writer that had to guess would put the value at an address
   * provisioning never asks about.
   */
  test("the request carries the backend and the scope the write resolved", async () => {
    const store = new StubDispatcher();
    await dispatchSecretWrite(
      backendRoutedDispatcher({ d1: new StubDispatcher(), "cf-secrets-store": store }),
      { ...write, scope: "global", requested: undefined },
      DEFAULT_ENVIRONMENTS,
    );
    expect(store.calls).toEqual([
      expect.objectContaining({ backend: "cf-secrets-store", scope: "global", name: "SUPPLIED" }),
    ]);
  });

  /**
   * **And the third fact, which decides what the value is wrapped in rather than where it goes.**
   *
   * A `bootstrap` secret's destination holds the value itself, because its reader runs before the decoder
   * exists. The writer downstream cannot re-derive that from a registry it does not have, so the request
   * carries it — and a request that dropped it would envelope the one value that cannot say so (#517).
   */
  test("the request carries whether the secret is read straight from its binding", async () => {
    const store = new StubDispatcher();
    await dispatchSecretWrite(
      backendRoutedDispatcher({ d1: new StubDispatcher(), "cf-secrets-store": store }),
      { ...write, bootstrap: true },
      DEFAULT_ENVIRONMENTS,
    );
    expect(store.calls).toEqual([expect.objectContaining({ bootstrap: true })]);
  });

  /**
   * **A pre-flight asks the writer that will perform the write, and never a different one.**
   *
   * It exists for `pithy secrets rotate`, which calls an issuer before it stores — so a pre-flight routed
   * to the wrong backend would answer about a destination the value is not going to, which is worse than
   * not asking at all.
   */
  test("a preflight follows the same route as the write", async () => {
    const store = new StubDispatcher();
    const asked: SecretWriteRequest[] = [];
    const routed = backendRoutedDispatcher({
      d1: {
        dispatch: async () => {},
        preflight: async () => {
          throw new Error("routed to the wrong backend");
        },
      },
      "cf-secrets-store": {
        dispatch: (request) => store.dispatch(request),
        preflight: async (request) => {
          asked.push(request);
        },
      },
    });

    await routed.preflight({ ...write, env: "prod", bootstrap: false });

    expect(asked.map((request) => request.name)).toEqual(["SUPPLIED"]);
    // Asking is not writing: the point of the seam is that a refusal costs nothing.
    expect(store.calls).toEqual([]);
  });

  /**
   * **Every route has a pre-flight, and the type is what says so** (#517).
   *
   * This replaces a test that asserted the opposite — *a backend with no preflight is not an error* — and
   * the assertion it made was true of the code and wrong about the product. The router called the seam
   * with `?.`, so the `d1` half implementing nothing resolved: `pithy secrets rotate` called the issuer,
   * took a new credential, and only then discovered the manager would refuse the write. A missing
   * pre-flight is now a compile error, which no runtime test can state — so what this states instead is
   * the one way left to route a backend that refuses nothing in advance, and that it has to be said.
   */
  test("a backend that refuses nothing in advance says so, and cannot say it by omission", async () => {
    const store = new StubDispatcher();
    const routed = backendRoutedDispatcher({
      d1: new StubDispatcher(),
      "cf-secrets-store": withoutPreflight(store, "nothing about this destination is knowable in advance"),
    });

    await expect(routed.preflight({ ...write, env: "prod" })).resolves.toBeUndefined();
    // A waiver waives the question, not the write.
    await routed.dispatch({ ...write, env: "prod" });
    expect(store.calls.map((call) => call.name)).toEqual(["SUPPLIED"]);
    // And the reason is demanded, at composition time, where a refusal costs a startup and not a rotation.
    expect(() => withoutPreflight(store, "  ")).toThrow(/must say why/);
  });
});
