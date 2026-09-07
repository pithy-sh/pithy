/**
 * Pack every published package and hold the tarballs to what an adopter must receive.
 *
 *   bun scripts/verifyPublished.ts
 *
 * The artifact-level half of the rule `tooling/release/src/manifests.test.ts` states on the manifests.
 * Both halves exist for the reason `packages/cli/scripts/verifyPack.ts` gives: **`files` does not fail
 * on a missing path**, so a field naming `pithy.manifest.json` passes every static check whether or not
 * the file is there, and only the tarball knows the difference.
 *
 * It packs, so it is slow — around twenty seconds for twenty-two packages. That is why it is a release
 * step rather than a unit test, exactly as `pack:verify` is.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFaults } from "@pithy-sh/release/src/packing";
import { publishedPackages } from "@pithy-sh/release/src/workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What `npm pack --dry-run` says would ship, without writing a tarball. */
function packedEntries(dir: string): string[] {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(root, dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const [report] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  return (report?.files ?? []).map((file) => file.path);
}

/**
 * The first bytes of each distributed file in the tarball, by path.
 *
 * Extracted from a real pack, like the manifest below and for the same reason: the notice has to be on
 * the copy that leaves, and a build path that skips the stamp is invisible to a check that reads the
 * same tree the stamper wrote. Two lines is enough to see a header and cheap enough for a thousand
 * files — `bin.js` carries its shebang first, so the notice is on the second line there.
 */
function packedHeads(dir: string): Record<string, string> {
  const out = mkdtempSync(join(tmpdir(), "pithy-heads-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", out], {
      cwd: join(root, dir),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [tarball] = execFileSync("ls", [out], { encoding: "utf8" }).trim().split("\n");
    const listing = execFileSync("tar", ["-tzf", join(out, tarball as string)], { encoding: "utf8" })
      .split("\n")
      .filter((entry) => /^package\/dist\/.*\.(js|d\.ts)$/.test(entry));

    const heads: Record<string, string> = {};
    for (const entry of listing) {
      const text = execFileSync("tar", ["-xzOf", join(out, tarball as string), entry], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      // Three lines, not two: `bin.js` opens with a shebang, which pushes the identifier to the third.
      heads[entry.replace(/^package\//, "")] = text.split("\n").slice(0, 3).join("\n");
    }
    return heads;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * The manifest **as it exists inside the tarball**.
 *
 * A real pack, extracted, rather than the file on disk. The two are allowed to differ — a `prepack`
 * may rewrite the manifest, and the entire `workspace:*` defect was a rewrite that everyone assumed
 * happened and nothing performed. Reading the source tree here would assert the assumption instead of
 * the artifact, which is how it shipped twice.
 */
function packedManifest(dir: string): Record<string, unknown> {
  const out = mkdtempSync(join(tmpdir(), "pithy-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", out], {
      cwd: join(root, dir),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [tarball] = execFileSync("ls", [out], { encoding: "utf8" }).trim().split("\n");
    const json = execFileSync("tar", ["-xzOf", join(out, tarball as string), "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(json) as Record<string, unknown>;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const faults: string[] = [];
for (const pkg of publishedPackages(root)) {
  const manifest = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8")) as { files?: string[] };
  faults.push(
    ...packFaults({
      name: pkg.name,
      entries: packedEntries(pkg.dir),
      heads: packedHeads(pkg.dir),
      expectsManifest: existsSync(join(root, pkg.dir, "pithy.manifest.json")),
      declared: manifest.files,
      manifest: packedManifest(pkg.dir) as Parameters<typeof packFaults>[0]["manifest"],
    }),
  );
}

if (faults.length > 0) {
  process.stderr.write(`\n${faults.length} packages are not fit to publish.\n\n`);
  for (const fault of faults) process.stderr.write(`  - ${fault}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write(`${publishedPackages(root).length} packages pack clean.\n`);
