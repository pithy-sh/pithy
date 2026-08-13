// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import type { ManagedEnvironment } from "../scope";
import {
  dispatchSecretWrite,
  environmentsWrittenBeforeFailure,
  type SecretDispatcher,
  type SecretWrite,
  type SecretWriteRequest,
} from "./dispatch";

class StubDispatcher implements SecretDispatcher {
  readonly calls: SecretWriteRequest[] = [];
  async dispatch(request: SecretWriteRequest): Promise<void> {
    this.calls.push(request);
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
