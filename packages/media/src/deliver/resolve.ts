// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { MEDIA_IMAGES_SIGNING_SECRET, MEDIA_STREAM_SIGNING_SECRET, mediaOwnSecretsRegistry } from "../secret/registry";
import { type DeliverySigner, deliverySigner } from "./sign";

/**
 * The delivery signer for a request, over the signing keys `pithy media provision` stored.
 *
 * Each key is read through the one `secretsStore` reader and **only when this is called** — a request that
 * delivers public media never asks. A key that is not there is not an error here: the signer refuses at
 * the one call that needs it, naming the command that provisions it, so a project that serves only images
 * is not refused for lacking a Stream key.
 */
export async function resolveDeliverySigner(env: SecretsStoreEnv): Promise<DeliverySigner> {
  const secrets = await sharedSecretsStore(env, mediaOwnSecretsRegistry);
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const images = read(() => secrets.get(MEDIA_IMAGES_SIGNING_SECRET));
  const stream = read(() => secrets.get(MEDIA_STREAM_SIGNING_SECRET));
  return deliverySigner({ ...(images ? { images } : {}), ...(stream ? { stream } : {}) });
}
