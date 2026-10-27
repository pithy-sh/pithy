// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import {
  type CapabilitySettings,
  SettingsAccountIncomplete,
  type SettingsFinding,
  type UnansweredEnvironment,
} from "@pithy-sh/core/src/capability/settings";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { auditCheckpointBucketName } from "../provision/resolveAuditConfig";
import { AUDIT_CHECKPOINT_BINDING, AUDIT_CHECKPOINT_LOCK_PREFIX } from "./checkpoint";

/**
 * **`pithy doctor`'s line on the checkpoint bucket's object lock (#822).**
 *
 * A checkpoint is evidence only while nothing can replace it. The Worker cannot tell through its binding whether
 * the bucket is locked, so doctor asks the account, per deployed environment: a bucket with no indefinite lock over
 * the checkpoints is a finding, and so is a bucket that does not exist yet — the chain then has nothing outside the
 * database to be held to. A bucket that is locked says nothing, which is doctor's way of saying it is in force.
 *
 * `dev` is never asked: a developer's checkpoints are a local Miniflare bucket, and no lock means anything there.
 */
export function checkpointLockCheck(): CapabilitySettings {
  return {
    local: () => [],
    async account(context) {
      const findings: SettingsFinding[] = [];
      const unanswered: UnansweredEnvironment[] = [];
      for (const { name: environment } of context.environments) {
        if (environment === LOCAL_ENVIRONMENT) continue;
        const bucket = auditCheckpointBucketName(context.project, environment);
        try {
          const ask = context.account.r2BucketLock;
          if (!ask) {
            throw new InternalError({
              message: "This doctor cannot ask whether a bucket is locked.",
              detail: "SettingsAccountReader.r2BucketLock is absent.",
            });
          }
          const state = await ask.call(context.account, { bucket, prefix: AUDIT_CHECKPOINT_LOCK_PREFIX });
          if (state === "locked") continue;
          if (state === "missing") {
            const provision = remedy("provision", { flags: { "--env": environment, "--yes": true } });
            findings.push({
              setting: `${AUDIT_CHECKPOINT_BINDING} bucket`,
              environment,
              problem: `The checkpoint bucket ${bucket} does not exist, so the audit chain is held to nothing outside the database.`,
              action: provision.say((command) => `Run ${command} to create it, then lock it.`),
              ...(provision.fix === undefined ? {} : { fix: String(provision.fix) }),
            });
            continue;
          }
          const lock = remedy("audit lock", { flags: { "--env": environment } });
          findings.push({
            setting: `${AUDIT_CHECKPOINT_BINDING} object lock`,
            environment,
            problem: `Object lock is not in force on ${bucket}. Whoever can write the bucket can rewrite the checkpoints the audit chain is verified against.`,
            action: lock.say((command) => `Run ${command} to lock the checkpoints indefinitely.`),
            ...(lock.fix === undefined ? {} : { fix: String(lock.fix) }),
          });
        } catch (cause) {
          unanswered.push({ environment, cause });
        }
      }
      if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
      return findings;
    },
  };
}
