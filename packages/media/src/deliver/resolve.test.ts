// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { SecretsAccessor } from "@pithy-sh/secrets/src/secretsStore";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, describe, expect, test } from "vitest";
import { MEDIA_IMAGES_SIGNING_SECRET, MEDIA_STREAM_SIGNING_SECRET, mediaSecretsRegistry } from "../secret/registry";
import { resolveDeliverySigner } from "./resolve";

const EXPIRES = new Date("2026-10-16T13:00:00.000Z");
const ENV = {} as SecretsStoreEnv;

/** Configure the shared accessor to hold exactly these values, and to fail reading these names. */
function holding(resolved: Record<string, unknown>, failures: Record<string, Error> = {}): void {
  configureSharedSecrets({
    registry: mediaSecretsRegistry,
    resolve: async () =>
      new SecretsAccessor(
        mediaSecretsRegistry,
        Object.fromEntries(
          Object.entries(resolved).map(([name, current]) => [
            name,
            { current, currentVersion: "1", versions: { 1: current } },
          ]),
        ),
        undefined,
        failures,
      ),
  });
}

afterEach(() => resetSharedSecrets());

describe("resolveDeliverySigner", () => {
  test("an images-only project signs images and is not refused for lacking a Stream key", async () => {
    holding({ [MEDIA_IMAGES_SIGNING_SECRET]: { key: "images-secret" } });
    const signer = await resolveDeliverySigner(ENV);

    const signed = new URL(await signer.signImageUrl("https://imagedelivery.net/h/img-1/public", EXPIRES));
    expect(signed.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
    // The missing key refuses at the one call that needs it, naming the command that provisions it.
    await expect(signer.streamToken("uid-1", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported", action: expect.stringContaining("Provision media again") },
    });
  });

  test("a key whose read fails is treated as absent, not as a failed resolution", async () => {
    holding(
      { [MEDIA_IMAGES_SIGNING_SECRET]: { key: "images-secret" } },
      { [MEDIA_STREAM_SIGNING_SECRET]: new Error("the vault did not answer") },
    );
    const signer = await resolveDeliverySigner(ENV);
    await expect(signer.signImageUrl("https://imagedelivery.net/h/img-1/public", EXPIRES)).resolves.toContain("sig=");
    await expect(signer.streamToken("uid-1", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported" },
    });
  });

  test("with no key at all it still resolves, and each product refuses on its own", async () => {
    holding({});
    const signer = await resolveDeliverySigner(ENV);
    await expect(signer.signImageUrl("https://imagedelivery.net/h/i/v", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported" },
    });
    await expect(signer.streamToken("uid-1", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported" },
    });
  });
});
