// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { secretsTables } from "../data/tables";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import { type AtRestRotationResult, runAtRestKeyRotation, type StepRunner } from "../rotation/atRestKeyRotation";
import { RotationTracker } from "../store/rotationTracker";
import { bindingConfigReader, type ConfigReader } from "./configReader";
import type { ConfigWriter } from "./configWriter";

/**
 * The manager's env as far as the owned vaults go: `OWNED_VAULTS` names, as a JSON array, each D1 binding that holds
 * a Worker's own vault under this environment's master key. Absent on a manager that re-seals only its own.
 */
export interface OwnedVaultsEnv extends SecretsStoreEnv {
  OWNED_VAULTS?: string;
}

const OwnedVaults = z.array(z.string().min(1).describe("One owned vault's D1 binding.")).describe("The owned vaults.");

/**
 * Every owned vault the manager is stamped with, by binding. A stamped binding with no D1 behind it is refused: a
 * vault the pass cannot reach is a vault whose rows it never counted, and the prune would retire their key.
 */
export function ownedVaults(env: OwnedVaultsEnv): { binding: string; d1: D1Database }[] {
  if (env.OWNED_VAULTS === undefined || env.OWNED_VAULTS === "") return [];
  const parsed = OwnedVaults.safeParse(JSON.parse(env.OWNED_VAULTS));
  if (!parsed.success) {
    throw new InternalError({
      message: "The secrets manager's OWNED_VAULTS var is not a list of bindings.",
      action: remedy("deploy").say((command) => `Redeploy the manager with ${command}.`),
      detail: "OWNED_VAULTS did not parse as a string array",
    });
  }
  return parsed.data.map((binding) => {
    const d1 = (env as unknown as Record<string, D1Database | undefined>)[binding];
    if (d1 === undefined || typeof d1 !== "object") {
      throw new InternalError({
        message: `The secrets manager is stamped with an owned vault ${binding} it does not bind.`,
        action: remedy("deploy").say(
          (command) => `Redeploy the manager with ${command}, so every owned vault is bound.`,
        ),
        detail: `OWNED_VAULTS names ${binding}, and env.${binding} is absent`,
      });
    }
    return { binding, d1 };
  });
}

/**
 * The at-rest key-rotation Workflow's body: build the store, config, reader and tracker from the worker
 * env and run the rotation core in durable steps. The `configWriter` is injected so this is testable
 * against Miniflare with a stub (the only thing that needs a live CF Secrets Store is the write-back
 * itself); the deployed worker passes the real `SecretsStoreConfigWriter`.
 *
 * `configReader` defaults to this Worker's own `SECRETS_ENCRYPTION_KEYS` binding, which is the whole point
 * of the read-back — the write goes to Cloudflare over REST by composed entry name, and only the
 * binding can say whether it landed where anything reads. It is a parameter for one reason: under
 * Miniflare the binding is a fixed string, so a local test of a write that *lands* has to supply the other
 * end of it. A local test that supplies nothing gets the real thing, and the read-back correctly refuses
 * to confirm a write Miniflare's fixed binding will never show.
 */
export async function runRotationWorkflow(
  env: OwnedVaultsEnv,
  configWriter: ConfigWriter,
  step: StepRunner,
  configReader: ConfigReader = bindingConfigReader(env),
  instanceId?: string,
): Promise<AtRestRotationResult> {
  const config = await resolveEncryptionConfig(env);
  const db = createDatabase(env.SECRETS, secretsTables);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  const owned = ownedVaults(env).map(({ binding, d1 }) => ({ binding, db: createDatabase(d1, secretsTables) }));
  // The pass's identity, straight from the platform. See `AtRestRotationOptions.rotatedBy` for why it must
  // be the instance's own id and not something recomposed from the pass's inputs.
  return runAtRestKeyRotation(
    { db, config, configWriter, configReader, tracker, owned },
    step,
    instanceId === undefined ? {} : { rotatedBy: instanceId },
  );
}
