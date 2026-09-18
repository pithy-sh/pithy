// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Packument, RegistryFetch, RegistryResponse } from "../kitPackages/registry";
import type { InstallRunner } from "../project/packageManager";

/**
 * A package manager that does what `<pm> install` does to the one fact `pithy upgrade --packages` checks:
 * every `@pithy-sh/*` range in the root and `apps/*` manifests is installed at its floor, in that manifest's
 * own `node_modules`. The floor is what a rewritten range pins, so a fake that installed anything else
 * would be testing itself.
 *
 * `hold` names packages it leaves where they are, to stand in for an install that resolved something the
 * range did not ask for.
 */
export function fakeInstall(
  options: { hold?: string[] } = {},
): InstallRunner & { calls: [string, string[], string][] } {
  const calls: [string, string[], string][] = [];
  const runner = async (command: string, args: string[], cwd: string) => {
    calls.push([command, args, cwd]);
    let apps: string[] = [];
    try {
      apps = (await readdir(join(cwd, "apps"))).map((name) => join(cwd, "apps", name));
    } catch {
      // no Workers
    }
    for (const dir of [cwd, ...apps]) {
      let doc: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        doc = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      for (const [name, spec] of Object.entries({ ...doc.dependencies, ...doc.devDependencies })) {
        if (!name.startsWith("@pithy-sh/") || (options.hold ?? []).includes(name)) continue;
        const version = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(spec)?.[1];
        if (!version) continue;
        const home = join(dir, "node_modules", ...name.split("/"));
        await mkdir(home, { recursive: true });
        await writeFile(join(home, "package.json"), JSON.stringify({ name, version }));
      }
    }
  };
  return Object.assign(runner, { calls });
}

/** A packument publishing `versions`, the last one `latest` unless named. */
export function fakePackument(
  name: string,
  versions: string[],
  latest = versions[versions.length - 1] ?? "0.0.0",
  dependencies: Record<string, Record<string, string>> = {},
): Packument {
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        {
          version,
          ...(dependencies[version] ? { dependencies: dependencies[version] } : {}),
          dist: {
            tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
            integrity: "sha512-AA==",
          },
        },
      ]),
    ),
  };
}

/**
 * A registry serving `docs`: a packument for each name (`null` is a 404), the `/latest` document doctor reads,
 * and any tarball in `tarballs` by URL. Everything else is a 404.
 */
export function fakeRegistry(
  docs: Record<string, Packument | null>,
  tarballs: Record<string, Uint8Array> = {},
): RegistryFetch & ((url: string) => Promise<RegistryResponse>) {
  const respond = (status: number, body: unknown, bytes: Uint8Array = new Uint8Array()): RegistryResponse => ({
    ok: status === 200,
    status,
    json: async () => body,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  });
  return async (url: string) => {
    const tarball = tarballs[url];
    if (tarball) return respond(200, null, tarball);
    const latest = /^https:\/\/registry\.npmjs\.org\/(@pithy-sh%2F[^/]+)\/latest$/.exec(url);
    const name = decodeURIComponent(
      (latest?.[1] ?? url.replace("https://registry.npmjs.org/", "")).replace("%2F", "/"),
    );
    const doc = docs[name];
    if (!doc) return respond(404, null);
    if (latest) return respond(200, { name, version: doc["dist-tags"].latest });
    return respond(200, doc);
  };
}
