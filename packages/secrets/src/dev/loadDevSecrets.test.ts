// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { DEV_SECRETS_FILE, initialDevSecret } from "./devSecretsFile";
import { loadDevSecrets } from "./loadDevSecrets";

/** The thrown payload, or a failure — every case here asserts on `code`/`message`/`action`, never a Zod dump. */
function payload(fn: () => unknown): PithyError["payload"] {
  try {
    fn();
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("expected a PithyError");
}

describe("loadDevSecrets — the file is JSONC", () => {
  test("comments and trailing commas parse", () => {
    const source = `{
      // The session signing key. Minted by pithy add.
      "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } },
      /* Google is only here once someone enables it. */
      "auth-google-credentials": { "currentVersion": "1", "versions": { "1": { "clientId": "id" } } },
    }`;

    expect(loadDevSecrets(source)).toEqual({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "abc" } },
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id" } } },
    });
  });

  test("an empty file is an empty set of secrets, not an error", () => {
    expect(loadDevSecrets("{}")).toEqual({});
  });

  test("unparseable JSONC names the file and what to do", () => {
    const result = payload(() => loadDevSecrets("{ oops"));

    expect(result.code).toBe("validation/invalid_input");
    expect(result.message).toContain(DEV_SECRETS_FILE);
    expect(result.action).toBeDefined();
  });

  test("the reported path is the one the caller read", () => {
    const result = payload(() => loadDevSecrets("{ oops", { path: "apps/board/.dev.secrets.jsonc" }));

    expect(result.message).toContain("apps/board/.dev.secrets.jsonc");
  });

  test("a top-level array is refused — the file is a map of secret name to envelope", () => {
    expect(payload(() => loadDevSecrets("[]")).code).toBe("validation/invalid_input");
  });
});

describe("loadDevSecrets — every value is a full envelope", () => {
  test("a bare string value names the secret and shows the envelope", () => {
    const result = payload(() => loadDevSecrets(`{ "auth-session-secret": "abc" }`));

    expect(result.code).toBe("validation/invalid_input");
    expect(result.message).toContain("auth-session-secret");
    expect(result.action).toContain("currentVersion");
    expect(result.action).toContain("versions");
  });

  test("a bare object value is refused too — that ambiguity is what the envelope rule ends", () => {
    const result = payload(() => loadDevSecrets(`{ "auth-google-credentials": { "clientId": "id" } }`));

    expect(result.message).toContain("auth-google-credentials");
  });

  test("neither the message nor the detail ever echoes the value", () => {
    const result = payload(() => loadDevSecrets(`{ "auth-session-secret": "s3cr3t-material" }`));

    expect(JSON.stringify(result)).not.toContain("s3cr3t-material");
  });

  test("an empty versions map names the secret", () => {
    const result = payload(() => loadDevSecrets(`{ "a-b": { "currentVersion": "1", "versions": {} } }`));

    expect(result.message).toContain("a-b");
  });

  test("a currentVersion absent from versions names the secret and the version", () => {
    const result = payload(() => loadDevSecrets(`{ "a-b": { "currentVersion": "2", "versions": { "1": "v" } } }`));

    expect(result.message).toContain("a-b");
    expect(result.message).toContain("2");
  });

  test("a non-string currentVersion is refused — version keys are stringified integers", () => {
    const result = payload(() => loadDevSecrets(`{ "a-b": { "currentVersion": 1, "versions": { "1": "v" } } }`));

    expect(result.message).toContain("a-b");
  });

  test("a multi-version envelope keeps every version and the pointer", () => {
    const source = `{ "a-b": { "currentVersion": "2", "versions": { "1": "old", "2": "new" } } }`;

    expect(loadDevSecrets(source)).toEqual({ "a-b": { currentVersion: "2", versions: { "1": "old", "2": "new" } } });
  });
});

describe("initialDevSecret", () => {
  test("a minted value is written back as version 1", () => {
    expect(initialDevSecret("minted")).toEqual({ currentVersion: "1", versions: { "1": "minted" } });
  });

  test("what it produces is what the loader accepts", () => {
    const source = JSON.stringify({ "a-b": initialDevSecret({ clientId: "id" }) });

    expect(loadDevSecrets(source)).toEqual({ "a-b": { currentVersion: "1", versions: { "1": { clientId: "id" } } } });
  });
});
