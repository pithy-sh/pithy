// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { auth } from "../capability";
import { SCOPED_ORIGIN, SCOPED_REGISTRY } from "../test-utils/scopedBackend";
import { mcp } from "./capability";
import { mcpAuthorizationServer } from "./provider";

/**
 * **A composition the endpoint cannot serve is refused at build time, naming what to change.** Each of these would
 * otherwise build: a Worker with no one to sign the agent's user in, a provider whose tables sit in another database
 * than the sessions they are checked against, or two authorization servers in one auth instance.
 */

const base = (authOptions: Partial<Parameters<typeof auth>[0]> = {}): Capability[] => [
  secrets({ registry: SCOPED_REGISTRY }),
  email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
  auth({ baseURL: SCOPED_ORIGIN, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN], ...authOptions }),
];

function refusal(build: () => unknown): ValidationError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error("expected the composition to be refused");
}

describe("mcp() composition", () => {
  test("composes beside auth", () => {
    expect(() => createBackend({ capabilities: [...base(), mcp({ floor: "signed-in" })] })).not.toThrow();
  });

  test("refuses to compose without auth", () => {
    // createBackend's own dependency check answers first; the capability refuses too when composed any other way.
    expect(() =>
      createBackend({ capabilities: [secrets({ registry: SCOPED_REGISTRY }), mcp({ floor: "signed-in" })] }),
    ).toThrow(/requires the "auth"/);
    const capability = mcp({ floor: "signed-in" });
    const error = refusal(() => capability.compose?.({ capabilities: [capability] } as never));
    expect(error.message).toMatch(/requires the auth capability/);
  });

  test("refuses a database other than auth's, naming auth's", () => {
    const error = refusal(() =>
      createBackend({ capabilities: [...base(), mcp({ floor: "signed-in", database: "OTHER" })] }),
    );
    expect(error.message).toMatch(/different databases/);
    expect(error.payload.action).toContain('mcp({ database: "DB" })');
  });

  test("refuses an auth instance that already composes an OAuth provider", () => {
    const [provider] = mcpAuthorizationServer({ resource: `${SCOPED_ORIGIN}/mcp`, consentPage: "/agent-consent" });
    const error = refusal(() =>
      createBackend({ capabilities: [...base({ plugins: [provider] }), mcp({ floor: "signed-in" })] }),
    );
    expect(error.message).toMatch(/already composes an OAuth provider/);
  });

  test("refuses to serve before createBackend has composed it", () => {
    const capability = mcp({ floor: "signed-in" });
    const error = refusal(() => capability.routes?.(new Hono() as never));
    expect(error.message).toMatch(/not composed/);
  });
});
