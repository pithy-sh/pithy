// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import type { SecretName, SecretRegistry, SecretRegistryEntry, SecretValue } from "../registry";
import { SecretsAccessor } from "../secretsStore";
import { configureSharedSecrets } from "../sharedSecretsStore";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * How a test gives a capability a secret. One harness, so no capability invents a fixture shape of
 * its own.
 *
 * There was nothing to share before #153, because nothing was needed. Dev resolved **every** secret
 * from a plaintext binding whatever its registry said, so a test put `{"auth-session-secret": "x"}`
 * on the worker env and the reader took it. Four packages independently learned that trick, and it
 * was never a fixture: it was a product code path, bent. That path is gone — a `d1` secret is read
 * from its encrypted row in every environment now — and a bare string on the env is a
 * `ValidationError` naming the secret. These two functions are what replaces it.
 *
 * **Which one you use is decided by the runtime, not by taste.**
 *
 * - `*.workers.test.ts` → {@link seedSecrets}. There is a real D1 there, so write the real row and
 *   let the code under test read it through `secretsStore` exactly as a deployed worker does. Same
 *   value envelope, same AES-256-GCM envelope, same master-key resolution, same schema validation at
 *   the read. Nothing about the secrets pipeline is faked, which is the point of running in workerd.
 * - `*.test.ts` (Node) → {@link stubSecrets}. There is no D1 in the Node project and
 *   `SystemSecretsStore` needs one. So the resolved accessor is built in memory and installed at
 *   `configureSharedSecrets`'s `resolve` seam — a seam that exists to be replaced, rather than a
 *   product path bent into a fixture again.
 *
 * Both take the capability's own registry and a partial map of name → value, and both hold the value
 * to that registry: a `json` secret's fixture is checked against the entry's schema before it is
 * stored or resolved, so a fixture that production would reject fails here, naming the secret,
 * rather than three layers down at a read.
 *
 * The master key a seeding suite needs is `devEncryptionKeys` — in its own module, because a vitest
 * config cannot import one with runtime dependencies. See the note there.
 */

/** A test's values for a registry: secret name → its value, in the shape `get(name)` returns. */
export type SecretFixture<R extends SecretRegistry> = {
  [K in SecretName<R>]?: SecretValue<R[K]>;
};

/**
 * Write each named value into `env`'s `SECRETS` D1 as the encrypted row the reader reads — the
 * Workers-runtime idiom.
 *
 * Every value lands as version `"1"` of a fresh envelope, which is what a `pithy secrets create` or a
 * `pithy dev` seed writes, and the `kid` a token minted in a test will carry. Call it again for the
 * same name to overwrite: `put` upserts, so a case that wants different credentials than its suite's
 * default just seeds over them before the request.
 *
 * The secrets tables are created on first use, so a suite needs no migration step of its own — the
 * store is a fixture here, not the subject.
 */
export async function seedSecrets<R extends SecretRegistry>(
  env: SecretsStoreEnv,
  registry: R,
  fixture: SecretFixture<R>,
): Promise<void> {
  await ensureSecretsTables(env);
  const store = await SystemSecretsStore.fromEnv(env);
  for (const [name, value] of Object.entries(fixture)) {
    if (value === undefined) continue;
    const entry = declared(registry, name);
    const stored = entry.valueType === "text" ? String(value) : JSON.stringify(parsed(entry, name, value));
    await store.put(name, initialVersionedValue(stored), entry.valueType);
  }
}

/**
 * Install `fixture` as the shared per-invocation accessor's resolution of `registry` — the
 * Node-runtime idiom, where there is no D1 to seed.
 *
 * Values are held already parsed, exactly as {@link SecretsAccessor} holds them after a real read:
 * the object for a `json` secret, the string for a `text` one. Each is one version, `"1"`, current.
 *
 * A name the fixture omits stays **unresolved** rather than becoming `undefined` — so reading it
 * throws `secrets/not_found`, which is how a test says "this secret is declared but not provisioned"
 * without reaching past the accessor.
 *
 * Call `resetSharedSecrets()` in `afterEach`; the configuration is module-scoped, as it is in a
 * worker isolate.
 */
export function stubSecrets<R extends SecretRegistry>(registry: R, fixture: SecretFixture<R>): void {
  const accessor = stubSecretsAccessor(registry, fixture);
  configureSharedSecrets({ registry, resolve: async () => accessor });
}

/**
 * The accessor {@link stubSecrets} installs, on its own — for a test that calls a resolver directly
 * instead of going through the shared store.
 */
export function stubSecretsAccessor<R extends SecretRegistry>(
  registry: R,
  fixture: SecretFixture<R>,
): SecretsAccessor<R> {
  const resolved: Record<string, { current: unknown; currentVersion: string; versions: Record<string, unknown> }> = {};
  for (const [name, value] of Object.entries(fixture)) {
    if (value === undefined) continue;
    const entry = declared(registry, name);
    const current = parsed(entry, name, value);
    resolved[name] = { current, currentVersion: "1", versions: { "1": current } };
  }
  return new SecretsAccessor(registry, resolved);
}

/** The registry entry a fixture names, or a loud author error — a fixture for an undeclared secret is a typo. */
function declared(registry: SecretRegistry, name: string): SecretRegistryEntry {
  const entry = registry[name];
  if (!entry) {
    throw new InternalError({
      message: `Test fixture names '${name}', which this registry does not declare.`,
      detail: `secret fixture '${name}' is absent from the registry passed to the harness`,
    });
  }
  if (entry.keyed) {
    throw new InternalError({
      message: `Secret '${name}' is a keyspace, so it has no single value to seed.`,
      action: "Write a keyspace member the way the app does: secrets.putKeyed(name, key, value).",
      detail: `secret fixture '${name}' names a keyed entry`,
    });
  }
  return entry;
}

/**
 * A fixture value in the shape the accessor exposes: a `text` value passes through, a `json` value is
 * validated against the entry's own schema first.
 *
 * The check is here rather than left to the read because a fixture production would reject should
 * fail at the line that wrote it. Only issue paths and codes reach the message — the same rule the
 * reader follows, since a Zod issue can echo the value.
 */
function parsed(entry: SecretRegistryEntry, name: string, value: unknown): unknown {
  if (entry.valueType === "text") return value;
  const result = entry.schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new InternalError({
      message: `Test fixture for secret '${name}' does not satisfy its registry schema.`,
      detail: `secret fixture '${name}' failed registry validation: ${summary}`,
    });
  }
  return result.data;
}

/**
 * Create the secrets tables if this D1 does not have them yet, so seeding is a single call and a suite
 * needs no migration step of its own.
 *
 * The migration is the real one, run unmodified — never a hand-rolled `create table if not exists` —
 * so a schema change reaches every suite that seeds without any of them being edited. Presence is
 * probed with a query rather than by introspection because D1 refuses to read `sqlite_master`
 * (`SQLITE_AUTH`), which is what Kysely's SQLite introspector is built on.
 */
async function ensureSecretsTables(env: SecretsStoreEnv): Promise<void> {
  const db = createDatabase(env.SECRETS, secretsTables);
  const present = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select("name")
    .limit(1)
    .executeTakeFirst()
    .then(
      () => true,
      () => false,
    );
  if (present) return;
  await secrets_0001_init.up(db as unknown as Kysely<unknown>);
}
