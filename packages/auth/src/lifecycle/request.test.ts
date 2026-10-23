// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import { describe, expect, test } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { lifecycleDeps } from "./request";

/** A context carrying only what `lifecycleDeps` reads. */
function context(env: Record<string, unknown>): Context<PithyHonoEnv> {
  const emit = async (): Promise<void> => {};
  return { env, var: { emit, log: undefined } } as unknown as Context<PithyHonoEnv>;
}

function wiring(overrides: Partial<AuthWiring> = {}): AuthWiring {
  return {
    config: AuthConfig.parse({ baseURL: "https://api.example.com", retention: { purgeAfterDays: 9 } }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: undefined,
    turnstile: undefined,
    ...overrides,
  };
}

describe("lifecycleDeps", () => {
  test("hands the transitions this request's database, the resolved config and the adopter's hooks", () => {
    const onUserPurged = (): void => {};
    const deps = lifecycleDeps(context({ DB: {} }), wiring({ lifecycleHooks: { onUserPurged } }));
    expect(deps.config.retention.purgeAfterDays).toBe(9);
    expect(deps.hooks.onUserPurged).toBe(onUserPurged);
    expect(deps.enqueueEmail).toBeUndefined();
  });

  test("binds the email capability's enqueue to this request's env, so a mail goes where the request runs", async () => {
    const seen: { env: unknown; template: string }[] = [];
    const env = { DB: {}, EMAIL_MARKER: true };
    const deps = lifecycleDeps(
      context(env),
      wiring({
        enqueueEmail: async (bound, input) => {
          seen.push({ env: bound, template: input.template });
          return { id: 1, status: "queued" } as never;
        },
      }),
    );
    await deps.enqueueEmail?.({ to: "a@b.test", template: "accountSuspended", payload: {} });
    expect(seen).toEqual([{ env, template: "accountSuspended" }]);
  });

  test("with no hooks given, there are none — not a missing object", () => {
    expect(lifecycleDeps(context({ DB: {} }), wiring()).hooks).toEqual({});
  });

  test("carries the caller's audit context onto the deps, and none when there is none (#621)", () => {
    const audit = { ip: "203.0.113.7", requestId: "ray-1", metadata: { connectionId: "c-1" } };
    expect(lifecycleDeps(context({ DB: {} }), wiring(), audit).context).toEqual(audit);
    expect(lifecycleDeps(context({ DB: {} }), wiring()).context).toBeUndefined();
  });

  test("refuses loudly when the database binding is missing, rather than failing on the first write", () => {
    expect(() => lifecycleDeps(context({}), wiring())).toThrow(/auth database binding is missing/);
  });
});
