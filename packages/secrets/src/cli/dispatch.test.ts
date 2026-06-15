import { describe, expect, test } from "vitest";
import { dispatchSecretWrite, type SecretDispatcher, type SecretWrite, type SecretWriteRequest } from "./dispatch";

class StubDispatcher implements SecretDispatcher {
  readonly calls: SecretWriteRequest[] = [];
  async dispatch(request: SecretWriteRequest): Promise<void> {
    this.calls.push(request);
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

describe("dispatchSecretWrite", () => {
  test("an environment-scoped write dispatches to exactly the requested env", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(dispatcher, { ...base, backend: "d1", scope: "environment" });

    expect(targets).toEqual(["staging"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["staging"]);
    expect(dispatcher.calls[0]).toMatchObject({ mode: "create", name: "api-token", value: "v" });
  });

  test("a global d1 write fans out to both managers", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(dispatcher, { ...base, backend: "d1", scope: "global" });

    expect(targets).toEqual(["staging", "production"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["staging", "production"]);
  });

  test("a global cf-secrets-store write goes to production only", async () => {
    const dispatcher = new StubDispatcher();
    const targets = await dispatchSecretWrite(dispatcher, {
      ...base,
      backend: "cf-secrets-store",
      scope: "global",
    });

    expect(targets).toEqual(["production"]);
    expect(dispatcher.calls.map((c) => c.env)).toEqual(["production"]);
  });

  test("a delete dispatches with no value", async () => {
    const dispatcher = new StubDispatcher();
    await dispatchSecretWrite(dispatcher, {
      mode: "delete",
      name: "api-token",
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      requested: "production",
    });

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({ env: "production", mode: "delete", name: "api-token" });
    expect(dispatcher.calls[0]?.value).toBeUndefined();
  });
});
