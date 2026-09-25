// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secretsTables } from "../data/tables";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import { type AtRestRotationResult, runAtRestKeyRotation, type StepRunner } from "../rotation/atRestKeyRotation";
import { RotationTracker } from "../store/rotationTracker";
import { bindingConfigReader, type ConfigReader } from "./configReader";
import type { ConfigWriter } from "./configWriter";

/**
 * The at-rest key-rotation Workflow's body: build the store, config, reader and tracker from the worker
 * env and run the rotation core in durable steps. The `configWriter` is injected so this is testable
 * against Miniflare with a stub (the only thing that needs a live CF Secrets Store is the write-back
 * itself); the deployed worker passes the real `SecretsStoreConfigWriter`.
 *
 * `configReader` defaults to this Worker's own `SECRETS_ENCRYPTION_KEYS` binding, which is the whole point
 * of the read-back (`#647`) — the write goes to Cloudflare over REST by composed entry name, and only the
 * binding can say whether it landed where anything reads. It is a parameter for one reason: under
 * Miniflare the binding is a fixed string, so a local test of a write that *lands* has to supply the other
 * end of it. A local test that supplies nothing gets the real thing, and the read-back correctly refuses
 * to confirm a write Miniflare's fixed binding will never show.
 */
export async function runRotationWorkflow(
  env: SecretsStoreEnv,
  configWriter: ConfigWriter,
  step: StepRunner,
  configReader: ConfigReader = bindingConfigReader(env),
  instanceId?: string,
): Promise<AtRestRotationResult> {
  const config = await resolveEncryptionConfig(env);
  const db = createDatabase(env.SECRETS, secretsTables);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  // The pass's identity, straight from the platform. See `AtRestRotationOptions.rotatedBy` for why it must
  // be the instance's own id and not something recomposed from the pass's inputs.
  return runAtRestKeyRotation(
    { db, config, configWriter, configReader, tracker },
    step,
    instanceId === undefined ? {} : { rotatedBy: instanceId },
  );
}
