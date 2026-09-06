/**
 * Pack the kit, install it into an empty directory, and drive it the way an adopter would.
 *
 *   bun scripts/cleanRoom.ts             # install as a lockfile would resolve it
 *   bun scripts/cleanRoom.ts --floors    # install every third-party dep at its declared floor
 *
 * Three defects reached the registry in one day and **none was visible from inside this repository**:
 * `workspace:*` published unrewritten (invisible in a workspace, where it resolves); `pithy ui add`
 * crashing below zod 4.4.0 (invisible under a lockfile that resolves above it); and a `bun` shebang on
 * the binary (invisible where Bun is always installed). Each gate that existed ran against the checkout.
 *
 * This one does not. It packs what would be published, installs it with nothing else on disk, and runs
 * the first commands an adopter runs. `--floors` additionally pins every third-party dependency to the
 * bottom of its declared range, because a range is a promise about every version in it — which is the
 * defect underneath #475, not the crash it produced.
 *
 * The reasoning lives in `@pithy-sh/release/src/cleanRoom`; this file is the entry point CI names.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CleanRoomManifest, kitOverrides, thirdPartyFloors } from "@pithy-sh/release/src/cleanRoom";
import { publishedPackages } from "@pithy-sh/release/src/workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const atFloors = process.argv.includes("--floors");

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function fail(what: string, cause: unknown): never {
  process.stderr.write(`\nClean room failed: ${what}\n\n${cause instanceof Error ? cause.message : String(cause)}\n\n`);
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "pithy-cleanroom-"));
const packs = join(workspace, "packs");
const project = join(workspace, "project");
run("mkdir", ["-p", packs, project], root);

try {
  // 1. Pack every package that would be published — the artifact, never the source tree.
  process.stdout.write("Packing the kit.\n");
  const packed = new Map<string, string>();
  const manifests: CleanRoomManifest[] = [];
  for (const pkg of publishedPackages(root)) {
    const before = new Set(readdirSync(packs));
    run("npm", ["pack", "--pack-destination", packs], join(root, pkg.dir));
    const tarball = readdirSync(packs).find((file) => !before.has(file));
    if (tarball === undefined) fail(`packing ${pkg.name}`, "npm pack wrote no tarball");
    packed.set(pkg.name, join(packs, tarball));
    manifests.push(JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8")) as CleanRoomManifest);
  }
  process.stdout.write(`  ${packed.size} packages packed.\n`);

  // 2. A project with nothing in it but a pointer at those tarballs. `overrides` is what stops the
  //    installer resolving a sibling from the registry and testing last release against this one.
  const overrides = { ...kitOverrides(packed), ...(atFloors ? thirdPartyFloors(manifests) : {}) };
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "cleanroom", private: true, version: "0.0.0", overrides }, null, 2)}\n`,
  );

  const cliTarball = packed.get("@pithy-sh/cli");
  if (cliTarball === undefined) fail("locating the CLI", "@pithy-sh/cli was not packed");

  process.stdout.write(atFloors ? "Installing at declared floors.\n" : "Installing.\n");
  try {
    run("bun", ["add", cliTarball as string], project);
  } catch (cause) {
    // This is the `workspace:*` shape: resolution fails before anything lands on disk.
    fail("installing @pithy-sh/cli into an empty directory", cause);
  }

  // Then the rest, because the CLI is not what an adopter composes. Its dependencies are the tooling
  // ones; `@pithy-sh/vite`, `@pithy-sh/auth` and the capabilities arrive in an adopter's project
  // because they chose them, and they are the packages the node probe below has to be able to reach.
  const rest = [...packed].filter(([name]) => name !== "@pithy-sh/cli").map(([, tarball]) => tarball);
  try {
    run("bun", ["add", ...rest], project);
  } catch (cause) {
    fail("installing the rest of the kit beside it", cause);
  }

  // What actually landed. A gate that cannot show its own inputs cannot be trusted to have tested
  // them — and `--floors` is exactly the mode where "it passed" and "it pinned nothing" look alike.
  const installed = (name: string): string => {
    const path = join(project, "node_modules", name, "package.json");
    if (!existsSync(path)) return "absent";
    return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  };
  const witnesses = ["zod", "hono", "kysely", "@hono/zod-validator"];
  process.stdout.write(`  installed: ${witnesses.map((name) => `${name}@${installed(name)}`).join("  ")}\n`);

  // 3. Drive it. `--version` returns before the first dynamic import, so it proves the shebang and
  //    almost nothing else; `init` and `ui add` are the commands that reach the command tree, the
  //    template resolver and the manifest reader — which is where the last two defects lived.
  const pithy = join(project, "node_modules", ".bin", "pithy");
  if (!existsSync(pithy)) fail("finding the pithy binary", `${pithy} was not linked by the install`);

  const app = join(workspace, "app");
  run("mkdir", ["-p", app], root);
  run("git", ["init", "-q", "."], app);

  for (const [what, args, cwd] of [
    ["pithy --version", ["--version"], project],
    ["pithy init", ["init", "--name", "cleanroom", "--worker", "api"], app],
    ["pithy ui add react", ["ui", "add", "react", "--worker", "api"], app],
  ] as const) {
    process.stdout.write(`  ${what}\n`);
    try {
      run(pithy, [...args], cwd);
    } catch (cause) {
      fail(what, cause);
    }
  }

  // 4. Node imports the kit. **The defect #476 closed, and the one nothing inside this repository can
  //    see**: every consumer here has a bundler — wrangler, Vite, vitest transforming a test — and node
  //    is the one that does not. It refuses to strip types under `node_modules` and cannot be argued
  //    out of it, so an adopter's `vitest.config.ts` importing `@pithy-sh/vite` died on the raw
  //    TypeScript `exports` used to name. `node`, deliberately, and never `bun`, which strips happily
  //    and would pass on the broken tree.
  //
  //    A declaration beside each, because a module that loads with no types beside it is half published
  //    and the half that is missing is the half a compiler reads.
  const probes = [
    "@pithy-sh/core/src/error/pithyError",
    "@pithy-sh/core/src/data/codecs",
    "@pithy-sh/vite/src/plugin",
    "@pithy-sh/vite/src/testPlugin",
    "@pithy-sh/auth/src/capability",
    "@pithy-sh/payments/src/capability",
    "@pithy-sh/i18n/src/capability",
  ];
  process.stdout.write("  node imports the kit\n");
  for (const specifier of probes) {
    try {
      run("node", ["-e", `await import(${JSON.stringify(specifier)})`], project);
    } catch (cause) {
      fail(`node importing ${specifier}`, cause);
    }
    const resolved = run(
      "node",
      ["-e", `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
      project,
    );
    const types = fileURLToPath(resolved).replace(/\.js$/, ".d.ts");
    if (!existsSync(types)) fail(`locating types for ${specifier}`, `${types} does not exist`);
  }

  process.stdout.write(`\nClean room passed${atFloors ? " at declared floors" : ""}.\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
