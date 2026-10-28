// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PRESENCE_ROOMS_BINDING_SPEC } from "@pithy-sh/core/src/presence/declaration";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";
import { bindsPresenceRooms, presenceRoomsRequired, presenceRoomsStray } from "./presenceRooms";
import { applyReconcilePlan, buildReconcilePlan } from "./reconcile";
import { removeFromEntry, removeFromWrangler } from "./remove";

/**
 * **A composed capability that declares a room kind gets the room's binding, class tag and entry export; a
 * Worker where none does gets them taken out** — over a real scaffolded project, through the real
 * writers `pithy add`, `pithy upgrade` and `pithy remove` run.
 */

const EXPORT_LINE = 'export { PresenceRoom } from "@pithy-sh/core/src/presence/durableObject";';

/** A kit capability that declares rooms: its manifest names the room's binding exactly as core spells it. */
const ROOMS = CapabilityManifest.parse({
  name: "rooms",
  package: "@pithy-sh/rooms",
  requiredBindings: [{ type: "d1", name: "DB" }, PRESENCE_ROOMS_BINDING_SPEC],
});

/** A second one, so a removal can be asked whether anything else still declares rooms. */
const DESKS = CapabilityManifest.parse({
  name: "desks",
  package: "@pithy-sh/desks",
  requiredBindings: [PRESENCE_ROOMS_BINDING_SPEC],
});

/** The adopter's own app capability, declaring a room kind — no manifest, so its composed instance is the authority. */
function appWithRooms(): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    adminRoutes: [
      { method: "GET", path: "/app/orders/:id", scope: "app:orders:read", kind: "reads", summary: "Read one order." },
    ],
    presence: {
      basePath: "/app",
      ticketKey: "k",
      rooms: [{ kind: "app.order", scope: "app:orders:read", activities: ["viewing"] }],
    },
  });
}

const appWithout = (): Capability => defineCapability({ name: "app", requiredBindings: [] });

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-presence-"));
  await scaffoldProject({ targetDir: dir, appName: "rooms" });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function installManifest(manifest: CapabilityManifest): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@pithy-sh", manifest.name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
}

interface Wrangler {
  main: string;
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }[];
  env?: Record<string, { durable_objects?: { bindings: { name: string; class_name: string }[] } }>;
}

async function wrangler(): Promise<Wrangler> {
  return parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Wrangler;
}

async function entry(): Promise<string> {
  return readFile(join(worker, (await wrangler()).main), "utf8");
}

/** Every environment's binding names for the room, top level first. */
function roomBindings(config: Wrangler): string[][] {
  return [config, ...Object.values(config.env ?? {})].map((stanza) =>
    (stanza.durable_objects?.bindings ?? [])
      .filter((binding) => binding.class_name === "PresenceRoom")
      .map((binding) => binding.name),
  );
}

function taggedClasses(config: Wrangler): string[] {
  return (config.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? []);
}

/** The migration history as Cloudflare replays it: each tag, and the classes it creates or deletes. */
function history(config: Wrangler): string[] {
  return (config.migrations ?? []).map(
    (migration) =>
      `${migration.tag} ${[
        ...(migration.new_sqlite_classes ?? []).map((name) => `+${name}`),
        ...(migration.deleted_classes ?? []).map((name) => `-${name}`),
      ].join(" ")}`,
  );
}

/** A Worker config that declares a room kind only when composed for `prod`. */
const PER_ENVIRONMENT_CONFIG = `export default {
  capabilities: [],
  app: {
    name: "app",
    requiredBindings:
      process.env.ENVIRONMENT === "prod"
        ? [{ type: "durable_object", name: "PRESENCE_ROOMS", className: "PresenceRoom", classModule: "@pithy-sh/core/src/presence/durableObject", optional: false }]
        : [],
  },
};
`;

async function upgrade(capabilities: readonly Capability[], app?: Capability) {
  const workerConfig = { capabilities: [...capabilities], app } as never;
  const all = app ? [...capabilities, app] : [...capabilities];
  const plan = await buildReconcilePlan({
    account: null,
    projectDir: dir,
    workerDir: worker,
    env: "dev",
    capabilities: all,
    workerConfig,
    // The same composition in every environment, unless a test says otherwise.
    composeEnvironment: async () => all,
  });
  const applied = await applyReconcilePlan({
    account: null,
    projectDir: dir,
    workerDir: worker,
    plan,
    migrate: false,
    env: "dev",
    capabilities: all,
    project: "rooms",
    app,
  });
  return { plan, applied };
}

describe("pithy add", () => {
  test("wires the room's binding in every environment, its class migration tag, and the entry export", async () => {
    await installManifest(ROOMS);
    await addCapability({ workerDir: worker, manifest: ROOMS, configValues: {}, project: "rooms" });

    const config = await wrangler();
    for (const names of roomBindings(config)) expect(names).toEqual(["PRESENCE_ROOMS"]);
    expect(taggedClasses(config)).toEqual(["PresenceRoom"]);
    expect(await entry()).toContain(EXPORT_LINE);
  });
});

describe("pithy upgrade", () => {
  test("wires the room for the adopter's own app capability when it declares a room kind", async () => {
    const { plan, applied } = await upgrade([], appWithRooms());
    expect(plan.perCapability.find((cap) => cap.name === "app")?.missingEntryExports).toEqual(["PresenceRoom"]);
    expect(applied.addedEntryExports).toEqual(["PresenceRoom"]);

    const config = await wrangler();
    for (const names of roomBindings(config)) expect(names).toEqual(["PRESENCE_ROOMS"]);
    expect(taggedClasses(config)).toEqual(["PresenceRoom"]);
    expect(await entry()).toContain(EXPORT_LINE);

    // Idempotent: a second run finds nothing to do and reports nothing stray.
    const again = await upgrade([], appWithRooms());
    expect(again.plan.strayPresenceRooms).toBe(false);
    expect(again.applied.addedEntryExports).toEqual([]);
  });

  test("takes the binding, tag and export out once no composed capability declares a room kind", async () => {
    await upgrade([], appWithRooms());
    const before = await entry();

    const { plan, applied } = await upgrade([], appWithout());
    expect(plan.strayPresenceRooms).toBe(true);
    expect(applied.retiredPresenceRooms).toBe(true);

    const config = await wrangler();
    for (const names of roomBindings(config)) expect(names).toEqual([]);
    // The creation tag stays, since a deployed script holds it, and a deleted_classes step retires the class:
    // a Worker that deployed with the room has instances, and Cloudflare refuses an upload that stops
    // exporting their class without one.
    expect(history(config)).toEqual(["v1 +PresenceRoom", "v2 -PresenceRoom"]);
    expect(await entry()).not.toContain("PresenceRoom");
    expect(before).toContain(EXPORT_LINE);

    // Nothing stray is left to report, and a second run appends nothing.
    expect((await upgrade([], appWithout())).plan.strayPresenceRooms).toBe(false);
    expect(history(await wrangler())).toEqual(["v1 +PresenceRoom", "v2 -PresenceRoom"]);
  });

  test("a room declared again after it was retired is created again, under a tag of its own", async () => {
    await upgrade([], appWithRooms());
    await upgrade([], appWithout());
    await upgrade([], appWithRooms());

    const config = await wrangler();
    for (const names of roomBindings(config)) expect(names).toEqual(["PRESENCE_ROOMS"]);
    expect(history(config)).toEqual(["v1 +PresenceRoom", "v2 -PresenceRoom", "v3 +PresenceRoom"]);
    expect(await entry()).toContain(EXPORT_LINE);
  });

  test("keeps the room in every environment while any environment's composition still declares one", async () => {
    // Composed for dev, the app declares no room; composed for prod, it does. Upgrading for dev must not take
    // prod's binding, tag or export with it.
    // Written first: a config is evaluated once per environment and cached, and the scaffold's own imports
    // packages this project never installed.
    await writeFile(join(worker, "pithy.config.ts"), PER_ENVIRONMENT_CONFIG);
    await upgrade([], appWithRooms());

    const plan = await buildReconcilePlan({ account: null, projectDir: dir, workerDir: worker, env: "dev" });
    expect(plan.strayPresenceRooms).toBe(false);
  });

  test("retires the room once no environment's composition declares one", async () => {
    await writeFile(
      join(worker, "pithy.config.ts"),
      PER_ENVIRONMENT_CONFIG.replace('process.env.ENVIRONMENT === "prod"', 'process.env.ENVIRONMENT === "nowhere"'),
    );
    await upgrade([], appWithRooms());

    const plan = await buildReconcilePlan({ account: null, projectDir: dir, workerDir: worker, env: "dev" });
    expect(plan.strayPresenceRooms).toBe(true);
  });

  test("leaves the room alone while a composed kit capability still declares one", async () => {
    await installManifest(ROOMS);
    await addCapability({ workerDir: worker, manifest: ROOMS, configValues: {}, project: "rooms" });
    const rooms = { name: ROOMS.name, requiredBindings: ROOMS.requiredBindings } as Capability;
    const { plan } = await upgrade([rooms], appWithout());
    expect(plan.strayPresenceRooms).toBe(false);
    expect(await entry()).toContain(EXPORT_LINE);
  });
});

describe("pithy remove", () => {
  async function addBoth(): Promise<void> {
    for (const manifest of [ROOMS, DESKS]) {
      await installManifest(manifest);
      await addCapability({ workerDir: worker, manifest, configValues: {}, project: "rooms" });
    }
  }

  test("keeps the room while another composed capability still declares one", async () => {
    await addBoth();
    // DB goes with rooms; nothing else declared it. The room stays.
    expect(await removeFromWrangler(worker, ROOMS, [DESKS])).toEqual(["DB"]);
    expect(await removeFromEntry(worker, "rooms", ROOMS, [DESKS])).toEqual([]);
    for (const names of roomBindings(await wrangler())) expect(names).toEqual(["PRESENCE_ROOMS"]);
    expect(await entry()).toContain(EXPORT_LINE);
  });

  test("takes the binding, tag and core's export out with the last capability that declares rooms", async () => {
    await addBoth();
    await removeFromWrangler(worker, ROOMS, [DESKS]);
    expect(await removeFromWrangler(worker, DESKS, [])).toEqual(["PRESENCE_ROOMS"]);
    expect(await removeFromEntry(worker, "desks", DESKS, [])).toEqual(["PresenceRoom"]);

    const config = await wrangler();
    for (const names of roomBindings(config)) expect(names).toEqual([]);
    // Retired, never spliced out of history: the same deleted_classes step `pithy upgrade` writes.
    expect(history(config)).toEqual(["v1 +PresenceRoom", "v2 -PresenceRoom"]);
    expect(await entry()).not.toContain("PresenceRoom");
  });
});

describe("the two questions", () => {
  test("required is read off the composed instances, never the manifests", () => {
    expect(presenceRoomsRequired([appWithRooms()])).toBe(true);
    expect(presenceRoomsRequired([appWithout()])).toBe(false);
  });

  test("stray means bound, and required by no environment's composition", async () => {
    const bound = [
      {
        env: "dev",
        stanza: { durable_objects: { bindings: [{ name: "PRESENCE_ROOMS", class_name: "PresenceRoom" }] } },
      },
      { env: "staging", stanza: {} },
      { env: "prod", stanza: {} },
    ];
    const composedFor = (requiring: string[]) => {
      const asked: string[] = [];
      const compose = async (env: string) => {
        asked.push(env);
        return requiring.includes(env) ? [appWithRooms()] : [appWithout()];
      };
      return { asked, compose };
    };

    const none = composedFor([]);
    expect(await presenceRoomsStray(bound, "dev", [appWithout()], none.compose)).toBe(true);
    // Every other environment is asked, never the one already composed.
    expect(none.asked).toEqual(["staging", "prod"]);

    expect(await presenceRoomsStray(bound, "dev", [appWithout()], composedFor(["prod"]).compose)).toBe(false);
    expect(await presenceRoomsStray(bound, "dev", [appWithRooms()], composedFor([]).compose)).toBe(false);
    expect(await presenceRoomsStray([{ env: "dev", stanza: {} }], "dev", [appWithout()], none.compose)).toBe(false);
    // A composition that cannot be read is one that might declare rooms: nothing is retired on a guess.
    const refusing = async () => {
      throw new Error("the config refused prod");
    };
    expect(await presenceRoomsStray(bound, "dev", [appWithout()], refusing)).toBe(false);
  });

  test("bound means the room's class under the room's binding, in any environment", () => {
    const bound = { durable_objects: { bindings: [{ name: "PRESENCE_ROOMS", class_name: "PresenceRoom" }] } };
    const other = { durable_objects: { bindings: [{ name: "PRESENCE_ROOMS", class_name: "MyOwnRoom" }] } };
    expect(bindsPresenceRooms([{ stanza: {} }, { stanza: bound }])).toBe(true);
    expect(bindsPresenceRooms([{ stanza: other }])).toBe(false);
  });
});
