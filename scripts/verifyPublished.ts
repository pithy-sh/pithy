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
 * It packs, so it is slow — a real tarball per package, once each. That is why it is a release step
 * rather than a unit test, exactly as `pack:verify` is, and why it runs inside `release:local` now: the
 * laptop release was the one path out of this repository that packed nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFaults } from "@pithy-sh/release/src/packing";
import { publishedPackages } from "@pithy-sh/release/src/workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything this check needs to know about one tarball, from a single pack. */
interface Packed {
  /** Every path in the tarball, relative to the package root. */
  entries: string[];
  /** The first bytes of each distributed file, by path — enough to see a notice, and no more. */
  heads: Record<string, string>;
  /** The manifest **as it exists inside the tarball**, which a `prepack` is allowed to have rewritten. */
  manifest: Record<string, unknown>;
  /** The version compiled into `dist/version.generated.js`, or `null` for a package that has no stamp. */
  stamp: string | null;
}

/** The constant `stampVersions.ts` writes, as it survives into the built module. */
const STAMPED = /PACKAGE_VERSION\s*=\s*["']([^"']+)["']/;

/**
 * Pack one package for real, and read everything out of that one tarball.
 *
 * **One pack, not four.** This used to pack a package three separate times — a `--dry-run --json` for
 * the entries, a real pack for the heads, another for the manifest — and adding the stamp would have
 * made it four. They are four questions about the same artifact, and asking them of four different
 * tarballs is how two of them end up describing a tree that has moved underneath.
 *
 * A real pack rather than `--dry-run`, because the dry run reports what npm *would* include and the
 * three reads below need the bytes.
 */
function packOnce(dir: string): Packed {
  const out = mkdtempSync(join(tmpdir(), "pithy-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", out], {
      cwd: join(root, dir),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [tarball] = execFileSync("ls", [out], { encoding: "utf8" }).trim().split("\n");
    const archive = join(out, tarball as string);

    const read = (entry: string): string =>
      execFileSync("tar", ["-xzOf", archive, entry], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"));
    const entries = listed.map((entry) => entry.replace(/^package\//, ""));

    // Three lines, not two: `bin.js` opens with a shebang, which pushes the identifier to the third.
    const heads: Record<string, string> = {};
    for (const entry of entries.filter((path) => /^dist\/.*\.(js|d\.ts)$/.test(path))) {
      heads[entry] = read(`package/${entry}`).split("\n").slice(0, 3).join("\n");
    }

    // Read from the tarball rather than from `dist/` on disk, for the reason every other check here is:
    // the copy that leaves is the only one whose age matters.
    const stampEntry = entries.find((path) => /^dist\/.*version\.generated\.js$/.test(path));
    const stamp = stampEntry ? (STAMPED.exec(read(`package/${stampEntry}`))?.[1] ?? null) : null;

    return { entries, heads, manifest: JSON.parse(read("package/package.json")) as Record<string, unknown>, stamp };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const faults: string[] = [];
for (const pkg of publishedPackages(root)) {
  const source = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8")) as {
    files?: string[];
    version: string;
  };
  const tarball = packOnce(pkg.dir);
  faults.push(
    ...packFaults({
      name: pkg.name,
      entries: tarball.entries,
      heads: tarball.heads,
      expectsManifest: existsSync(join(root, pkg.dir, "pithy.manifest.json")),
      declared: source.files,
      manifest: tarball.manifest as Parameters<typeof packFaults>[0]["manifest"],
      stamp: { manifest: source.version, built: tarball.stamp },
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
