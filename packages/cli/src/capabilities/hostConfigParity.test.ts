// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { email } from "@pithy-sh/email/src/capability";
import type { EmailWorkerWranglerTemplate } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { media } from "@pithy-sh/media/src/capability";
import { mediaBucketName } from "@pithy-sh/media/src/provision/provisionMedia";
import { resolveMediaConfig } from "@pithy-sh/media/src/provision/resolveMediaConfig";
import { payments } from "@pithy-sh/payments/src/capability";
import { resolvePaymentsConfig } from "@pithy-sh/payments/src/provision/resolvePaymentsConfig";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { ManagerWranglerTemplate } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { resolveManagerConfig } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { storage } from "@pithy-sh/storage/src/capability";
import { storageBucketName } from "@pithy-sh/storage/src/provision/provisionStorage";
import { resolveStorageConfig } from "@pithy-sh/storage/src/provision/resolveStorageConfig";
import { support } from "@pithy-sh/support/src/capability";
import { resolveSupportConfig } from "@pithy-sh/support/src/provision/resolveSupportConfig";
import { testers } from "@pithy-sh/testers/src/capability";
import { resolveTestersConfig } from "@pithy-sh/testers/src/provision/resolveTestersConfig";
import { vector } from "@pithy-sh/vector/src/capability";
import { vectorIndexName } from "@pithy-sh/vector/src/provision/provisionVector";
import { resolveVectorConfig } from "@pithy-sh/vector/src/provision/resolveVectorConfig";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";
import { kitSource } from "../project/kitSource";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { HOST_WORKERS, type HostResolveContext, hostWorkerFor } from "./hostRegistry";

/**
 * **The two paths that deploy a kit Worker must resolve it identically.**
 *
 * `pithy <capability> provision` resolves a host's committed template from the adopter's composed
 * config object; `pithy deploy --kit` resolves the *same* template through {@link HOST_WORKERS}. Both
 * end at `deployHostWorker`, both write a Worker of the same name into the same account, and neither
 * knows the other ran. So a difference between them is not a difference in output — it is two commands
 * overwriting each other, forever, one deploy apart.
 *
 * They differed. Five registry entries parsed their capability's schema defaults instead of reading
 * the composed object, so measured against the real committed templates at project `acme`, env `prod`:
 *
 * - **media** — `MEDIA_CONFIG` carried `recordStore: "d1"` whatever the adopter wrote, and in
 *   `"kv"` mode the deploy path *stripped* the `MEDIA` KV binding the provision path had just bound.
 * - **testers** — the entry passed `email: undefined`, so `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` and
 *   `EMAIL_THEME` were absent from the deployed host: a daily pass that silently mailed nobody.
 * - **storage, support, vector** — every tuned value replaced by its default, and vector additionally
 *   composed `<project>-<env>-<index>` where `vectorIndexName` composes
 *   `<project>-<env>-vector-<index>`, binding an index no provision run had created.
 *
 * The strongest available statement of "they agree" is to run both and compare, which is what this
 * does — the real committed template, the real resolvers, an adopter config that is **non-default in
 * every capability** so a defaulted resolution cannot pass by coincidence.
 *
 * `deployKit.test.ts` drives the same property end to end through `deployKitWorkers`; this drives it
 * at the seam, per capability, so a failure names which one.
 */

/** The project name every derived name below leads with. */
const PROJECT = "acme";

/** The environment resolved for. A deployed one, deliberately: this is the path `pithy dev` is not. */
const ENV = "prod";

/** The app Worker's origin for that environment. */
const BASE_URL = "https://api.acme.example";

/** The Secrets Store id, distinctive so a pass-through is visible in a diff. */
const STORE_ID = "store-1a2b3c";

/** The account id the secrets manager stamps into its own vars. */
const ACCOUNT_ID = "acct-9f8e7d";

/** The ids `pithy deploy --kit` reads off the app Worker's tracked `wrangler.jsonc`. */
const DATABASE_IDS: Record<string, string> = {
  DB: "db-app-1",
  SECRETS: "db-secrets-1",
  EMAIL_SUPPRESSIONS: "db-suppression-1",
};

/** The KV namespace ids from that same stanza. Media binds one, and only in `recordStore: "kv"`. */
const KV_IDS: Record<string, string> = { MEDIA: "kv-media-1" };

/**
 * The composed capabilities this project has, **every one of them tuned away from its defaults**.
 *
 * That is the whole method: a value that equals its default proves nothing here, because the defect
 * being pinned is a resolver that silently substitutes the default. Each entry below therefore sets at
 * least one field the schema would not have chosen.
 */
const COMPOSED = {
  email: email({
    fromAddress: "hello@acme.example",
    fromName: "Acme Support",
    baseUrl: BASE_URL,
    theme: "midnight",
  }),
  media: media({ recordStore: "kv", kvMetadata: ["type", "status"] }),
  storage: storage({ defaultVisibility: "public", pendingTtlSeconds: 3600 }),
  payments: payments({ billingSubject: "user", basePath: "/billing", graceGrantsAccess: true }),
  support: support({ inboundAddresses: ["help@support.acme.example"] }),
  testers: testers({ snapshotHourUtc: 9, activeWithinDays: 7 }),
  vector: vector({ indexes: { notes: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } } }),
  secrets: secrets({ registry: {} }),
} satisfies Record<string, Capability>;

/** Read a capability's committed template the way both paths read it: through the module graph. */
async function template<T extends WorkflowHostTemplate>(entry: string): Promise<T> {
  return parse(await readFile(join(dirname(kitSource(KIT_ROOT, entry)), "wrangler.jsonc"), "utf8")) as unknown as T;
}

/**
 * The context `pithy deploy --kit` builds for one host — {@link deployOneKitWorker}'s, with the ids it
 * reads off disk replaced by constants and nothing else changed.
 */
function deployContext(capability: Capability, siblings: readonly Capability[] = []): HostResolveContext {
  return {
    projectDir: KIT_ROOT,
    project: PROJECT,
    env: ENV,
    baseUrl: BASE_URL,
    databaseId: (binding) => DATABASE_IDS[binding] ?? `missing-${binding}`,
    kvNamespaceId: (binding) => KV_IDS[binding] ?? `missing-${binding}`,
    storeId: () => STORE_ID,
    accountId: () => ACCOUNT_ID,
    capability,
    siblings,
  };
}

/** What `pithy deploy --kit` would upload for one capability. */
async function viaKit(capability: keyof typeof COMPOSED): Promise<WorkflowHostTemplate> {
  const spec = hostWorkerFor(capability);
  if (!spec) throw new Error(`No host worker registered for ${capability}.`);
  const siblings = Object.values(COMPOSED).filter((one) => one !== COMPOSED[capability]);
  return spec.resolve(await template(spec.entry), deployContext(COMPOSED[capability], siblings));
}

/**
 * The three ids every host that reads a secret takes, in the shape its provisioner passes them.
 *
 * Written once here for the same reason `hostRegistry.ts` writes it once: four provisioners pass the
 * identical trio, and a test that spelled it out four times would be four chances to spell it
 * differently from the code it is comparing against.
 */
const SECRET_HOST = {
  project: PROJECT,
  env: ENV,
  appDatabaseId: DATABASE_IDS.DB as string,
  secretsDatabaseId: DATABASE_IDS.SECRETS as string,
  storeId: STORE_ID,
};

/**
 * What `pithy <capability> provision` would upload for the same capability, resolved from the same
 * composed config — each call mirroring its provisioner's `deployWorker` argument for argument.
 */
const VIA_PROVISION: Record<keyof typeof COMPOSED, () => Promise<WorkflowHostTemplate>> = {
  // `emailProvisioner.ts:202`.
  email: async () =>
    resolveEmailConfig(await template<EmailWorkerWranglerTemplate>("@pithy-sh/email/src/workflows/worker"), {
      ...SECRET_HOST,
      suppressionDatabaseId: DATABASE_IDS.EMAIL_SUPPRESSIONS as string,
      baseUrl: BASE_URL,
      theme: COMPOSED.email.emailConfig.theme,
      messages: COMPOSED.email.hostCatalogs(),
    }),
  // `mediaProvisioner.ts:325`, with the bucket from `ensureBucket` and the namespace from
  // `ensureKvNamespace` — which answers `null` unless the adopter's config says records live in KV.
  media: async () =>
    resolveMediaConfig(await template("@pithy-sh/media/src/workflows/worker"), {
      ...SECRET_HOST,
      resources: {
        bucketName: mediaBucketName(PROJECT, ENV),
        kvNamespaceId: COMPOSED.media.mediaConfig.recordStore === "kv" ? (KV_IDS.MEDIA as string) : null,
      },
      mediaConfig: COMPOSED.media.mediaConfig,
    }),
  // `storageProvisioner.ts:284`.
  storage: async () =>
    resolveStorageConfig(await template("@pithy-sh/storage/src/workflows/worker"), {
      ...SECRET_HOST,
      resources: { bucketName: storageBucketName(PROJECT, ENV) },
      storageConfig: COMPOSED.storage.storageConfig,
    }),
  // `paymentsProvisioner.ts:163`.
  payments: async () =>
    resolvePaymentsConfig(await template("@pithy-sh/payments/src/workflows/worker"), {
      ...SECRET_HOST,
      paymentsConfig: COMPOSED.payments.paymentsConfig,
    }),
  // `supportProvisioner.ts:295`. No secret, so no store id.
  support: async () =>
    resolveSupportConfig(await template("@pithy-sh/support/src/workflows/worker"), {
      project: PROJECT,
      env: ENV,
      appDatabaseId: DATABASE_IDS.DB as string,
      supportConfig: COMPOSED.support.supportConfig,
    }),
  // `testersProvisioner.ts:164`, with the sending identity `commands/testers.ts:404` copies off the
  // composed email capability — the four fields, `messages` included.
  testers: async () =>
    resolveTestersConfig(await template("@pithy-sh/testers/src/workflows/worker"), {
      project: PROJECT,
      env: ENV,
      appDatabaseId: DATABASE_IDS.DB as string,
      suppressionDatabaseId: DATABASE_IDS.EMAIL_SUPPRESSIONS as string,
      testersConfig: COMPOSED.testers.testersConfig,
      email: {
        fromAddress: COMPOSED.email.emailConfig.fromAddress,
        fromName: COMPOSED.email.emailConfig.fromName,
        theme: COMPOSED.email.emailConfig.theme,
        messages: COMPOSED.email.hostCatalogs(),
      },
    }),
  // `vectorProvisioner.ts:230`, with the names `provisionVector.ts`'s `plannedIndexNames` creates.
  vector: async () =>
    resolveVectorConfig(await template("@pithy-sh/vector/src/workflows/worker"), {
      project: PROJECT,
      env: ENV,
      appDatabaseId: DATABASE_IDS.DB as string,
      indexNames: Object.fromEntries(
        Object.keys(COMPOSED.vector.vectorConfig.indexes).map((index) => [index, vectorIndexName(PROJECT, index, ENV)]),
      ),
      config: COMPOSED.vector.vectorConfig,
    }),
  // `secretsProvisioner.ts:265`.
  secrets: async () =>
    resolveManagerConfig(await template<ManagerWranglerTemplate>("@pithy-sh/secrets/src/manager/worker"), {
      project: PROJECT,
      env: ENV,
      databaseId: DATABASE_IDS.SECRETS as string,
      storeId: STORE_ID,
      accountId: ACCOUNT_ID,
    }),
};

describe("pithy deploy --kit resolves what pithy <capability> provision resolves", () => {
  test("every registered host is compared — a tenth one cannot arrive unnoticed", () => {
    expect(HOST_WORKERS.map((spec) => spec.capability).sort()).toEqual(Object.keys(VIA_PROVISION).sort());
  });

  test.each(Object.keys(VIA_PROVISION) as (keyof typeof COMPOSED)[])("%s", async (capability) => {
    expect(await viaKit(capability)).toEqual(await VIA_PROVISION[capability]());
  });
});

/**
 * The three differences the equality above subsumes, asserted on their own.
 *
 * A deep-equal failure prints a diff of two whole wrangler configs, which is the right assertion and
 * the wrong error message. These name the facts an adopter would have lost, so the next reader learns
 * what broke rather than only that something did.
 */
describe("what the adopter's configuration decides", () => {
  test("media in kv mode keeps the MEDIA binding, at the namespace id the project declared", async () => {
    const config = await viaKit("media");
    expect(config.kv_namespaces).toEqual([{ binding: "MEDIA", id: KV_IDS.MEDIA }]);
    expect(JSON.parse(config.vars?.MEDIA_CONFIG as string).recordStore).toBe("kv");
  });

  test("testers deploys the project's sending identity, not a host that silently never mails", async () => {
    const config = await viaKit("testers");
    expect(config.vars?.EMAIL_FROM_ADDRESS).toBe("hello@acme.example");
    expect(config.vars?.EMAIL_FROM_NAME).toBe("Acme Support");
  });

  test("vector binds the index name pithy vector provision creates", async () => {
    const config = await viaKit("vector");
    expect(config.vectorize?.map((entry) => entry.index_name)).toEqual([vectorIndexName(PROJECT, "notes", ENV)]);
  });
});
