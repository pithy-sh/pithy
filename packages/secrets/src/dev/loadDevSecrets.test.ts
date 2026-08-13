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

  test("a zero-byte file is no secrets, the same answer the write path already gives", () => {
    // `touch .dev.secrets.jsonc` hard-failed `pithy add` with exit 1 while the write half of the same
    // module decided an empty file meant `{}` and merged into it. Two answers to one state.
    expect(loadDevSecrets("")).toEqual({});
    expect(loadDevSecrets("  \n\t ")).toEqual({});
  });

  test("a syntax error carries no cause — the parser's message embeds the whole file", () => {
    // comment-json's `SyntaxError` reads `Unexpected token '"', "{ ...the entire source... }" is not
    // valid JSON`. Attached as `cause`, every OAuth client secret in the file rides out with it.
    let thrown: unknown;
    try {
      loadDevSecrets(`{ "auth-session-secret": "s3cr3t-material" "b": 1 }`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).cause).toBeUndefined();
    expect(JSON.stringify((thrown as PithyError).payload)).not.toContain("s3cr3t-material");
    expect(String((thrown as PithyError).stack)).not.toContain("s3cr3t-material");
  });

  test("a syntax error still says where, because a position is not a value", () => {
    const result = payload(() => loadDevSecrets(`{\n  "a-b": { "currentVersion": "1" } "c": 1\n}`));

    expect(result.detail).toContain("line 2");
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

  test("a currentVersion naming an Object.prototype key is a dangling pointer, not a hit", () => {
    // `currentVersion in versions` walked the prototype chain, so `"toString"` passed the loader and
    // failed much later inside the store, where the error names neither the file nor the secret.
    const result = payload(() =>
      loadDevSecrets(`{ "a-b": { "currentVersion": "toString", "versions": { "1": "v" } } }`),
    );

    expect(result.message).toContain("a-b");
    expect(result.message).toContain("toString");
  });

  test("a value written bare is rejected as the envelope it is not, naming what it carries (#323)", () => {
    // The exact corruption #323 was diagnosed from: `SECRETS_ENCRYPTION_KEYS`' own `EncryptionConfig`
    // promoted to the top. It is the one payload that is structurally a *superset* of an envelope, so
    // a parser that strips unknown keys accepts it, drops `lastRotatedAt`, and leaves a base64 string
    // where a nested object belongs — a failure that then surfaces three frames later talking about
    // version "1", in a message naming neither this file nor this secret.
    const result = payload(() =>
      loadDevSecrets(
        `{ "SECRETS_ENCRYPTION_KEYS": { "currentVersion": "1", "versions": { "1": "a2V5" }, "lastRotatedAt": "2026-08-06T16:21:53.830Z" } }`,
      ),
    );

    expect(result.code).toBe("validation/invalid_input");
    expect(result.message).toContain("SECRETS_ENCRYPTION_KEYS");
    expect(result.message).toContain("lastRotatedAt");
  });

  test("any key beside currentVersion and versions is refused — the rule is the shape, not the key", () => {
    const result = payload(() =>
      loadDevSecrets(`{ "a-b": { "currentVersion": "1", "versions": { "1": "v" }, "note": "mine" } }`),
    );

    expect(result.message).toContain("a-b");
    expect(result.message).toContain("note");
  });

  test("what was found never includes what was in it", () => {
    const result = payload(() => loadDevSecrets(`{ "a-b": { "currentVersion": "1", "versions": "s3cr3t-material" } }`));

    expect(result.message).toContain("a-b");
    expect(JSON.stringify(result)).not.toContain("s3cr3t-material");
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
