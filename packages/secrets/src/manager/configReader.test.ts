// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import type { SecretsStoreEnv } from "../env/bindings";
import { bindingConfigReader } from "./configReader";

/**
 * **The read-back seam, and the classification it hangs on.**
 *
 * The rotation writes the master key to Cloudflare Secrets Store over REST by composed entry name, and
 * every consumer reads it back through the `SECRETS_ENCRYPTION_KEYS` binding. This is the second half —
 * and the half whose *failure codes* decide whether a bounded poll is bounded at all. A read that cannot
 * reach the store is the platform's business and must retry; a payload that will not parse is an
 * operator's, and retrying it burns the budget on an answer that cannot change. `resolveEncryptionConfig`
 * answers `secrets/crypto_failed` to both, and `secretsWorkflowRetry` calls that terminal — so a store
 * blip during the read-back would have ended the instance on its first attempt.
 */

const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": "c2VjcmV0LWtleS1ieXRlcy1wbGFudGVkLXNlbnRpbmVs" },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

function envWith(binding: SecretsStoreEnv["SECRETS_ENCRYPTION_KEYS"] | undefined): SecretsStoreEnv {
  return { SECRETS_ENCRYPTION_KEYS: binding } as unknown as SecretsStoreEnv;
}

async function codeOf(read: Promise<unknown>): Promise<string> {
  const thrown: unknown = await read.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof PithyError)) throw new Error(`expected a PithyError, got ${String(thrown)}`);
  return thrown.payload.code;
}

describe("bindingConfigReader", () => {
  test("parses the bound config through the same schema every consumer uses", async () => {
    expect(await bindingConfigReader(envWith(JSON.stringify(config))).read()).toEqual(config);
  });

  /**
   * **The retryable half.** A binding whose `.get()` rejects is the store being unreachable, and the
   * rotation's read-back leans on that being re-driven by the platform rather than counted against its
   * budget. Fails the moment this is folded back into `secrets/crypto_failed`, which `retryPolicy.ts`
   * names as terminal.
   */
  test("a store that would not answer is upstream, so the step retries", async () => {
    const binding = {
      get: () => Promise.reject(new Error("secrets store unavailable")),
    };
    expect(await codeOf(bindingConfigReader(envWith(binding)).read())).toBe("core/upstream_failed");
  });

  /**
   * **The terminal half, and it is a different fact.** A binding that is not wired is not a blip: the
   * Worker was deployed without it, and the next attempt finds the same nothing. Fails if the reader
   * wraps every failure as upstream on the way past.
   */
  test("a binding that is not configured is structural, so the step stops", async () => {
    expect(await codeOf(bindingConfigReader(envWith(undefined)).read())).toBe("secrets/not_found");
  });

  test("a payload that is not JSON is the operator's, not the platform's", async () => {
    expect(await codeOf(bindingConfigReader(envWith("{not json")).read())).toBe("secrets/crypto_failed");
  });

  test("a payload that is JSON and not a key set is refused the same way", async () => {
    expect(await codeOf(bindingConfigReader(envWith(JSON.stringify({ currentVersion: 1 }))).read())).toBe(
      "secrets/crypto_failed",
    );
  });

  /**
   * `#386`. The refusal is raised over a payload that *is* the key set, so anything it echoed would be
   * key material. Fails if a `detail` ever interpolates what it read.
   */
  test("nothing the reader refused travels on the refusal", async () => {
    const planted = `{"currentVersion":1,"versions":{"1":"PLANTED_KEY_MATERIAL"}}`;
    const thrown: unknown = await bindingConfigReader(envWith(planted))
      .read()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(PithyError);
    const rendered = JSON.stringify((thrown as PithyError).payload);
    expect(rendered).not.toContain("PLANTED_KEY_MATERIAL");
    expect(rendered).not.toContain("currentVersion");
  });
});
