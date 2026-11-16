// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash, type Hash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PRIVACY_ATTESTATION_VAR } from "@pithy-sh/core/src/privacy/posture";
import { parse } from "comment-json";
import { canonicalize, DEPLOY_STAMP_VAR } from "../provision/deployStamp";
import {
  effectiveDeployConfig,
  identityOf,
  selectedEnvironment,
  stanzaOf,
  type WranglerShape,
} from "./effectiveConfig";
import { readOptionalFile } from "./readOptionalFile";

/**
 * **What an app Worker's deploy stamp is: the bundle wrangler would upload, and the configuration it reads.**
 *
 * The bundle is `wrangler deploy --dry-run --outdir`'s output for the deploy's own argv, so it is wrangler's
 * bundling and nothing the kit re-implements. The configuration is the file that argv makes wrangler read,
 * parsed so a comment or a reordered key is not a change, together with the selected stanza, the argv itself
 * (a `--var` is configuration too, and the privacy attestation is, less the time it was written) and the files
 * of the assets directory it names.
 *
 * Two of wrangler's outputs are not part of it: `README.md`, which carries the time it was written, and the
 * source maps, which carry the output directory's absolute path. Neither is uploaded unless the configuration
 * asks for source maps, and then the configuration says so.
 */

/** How many hex characters of the digest the stamp carries. Change detection, not a signature. */
const STAMP_LENGTH = 32;

/** The switches that make `wrangler deploy` write its bundle to `outdir` and upload nothing. */
export function bundleArgs(outdir: string): string[] {
  return ["--dry-run", "--outdir", outdir];
}

/**
 * The switch that sets the stamp var on the upload. The upload carries `UNFINISHED_STAMP`; the hash is recorded
 * only once the deploy has finished.
 */
export function stampArgs(stamp: string): string[] {
  return ["--var", `${DEPLOY_STAMP_VAR}:${stamp}`];
}

/** Everything one stamp is computed from. */
export interface AppBundleOptions {
  /** The Worker's directory, where wrangler ran. */
  workerDir: string;
  /** The deploy's argv, without the bundle switches and without a stamp. */
  args: readonly string[];
  /** The environment wrangler inherits: half of what selects the stanza. */
  processEnv: NodeJS.ProcessEnv;
  /** Where wrangler wrote the bundle. */
  outdir: string;
  /** Puts a copy's paths back to the project's, so a dry run in a copy hashes what the deploy hashes. */
  normalize?: (text: string) => string;
}

/** One app Worker's stamp, and the script it deploys as. */
export interface AppBundle {
  /** The script the selected stanza publishes, or `null` when the configuration names none. */
  scriptName: string | null;
  /** The hash the deployed Worker carries as its stamp. */
  stamp: string;
}

/** The bundle's own files: everything wrangler wrote but its README and the source maps. */
const bundled = (path: string): boolean => path !== "README.md" && !path.endsWith(".map");

/** Text a bundler writes paths into, normalized; anything else is hashed as bytes. */
const TEXT = /\.(?:m?js|cjs|json|txt|html|css)$/;

/**
 * Every file under `dir`, as sorted posix paths relative to it. A missing directory holds none.
 *
 * Each entry is `stat`ed, which follows a link, because that is how wrangler builds its asset manifest: a link
 * to a file is uploaded as the file it leads to, and a link to a directory is listed but not descended into.
 */
async function filesUnder(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name) => ((await stat(join(dir, name)).catch(() => null))?.isFile() ? name : null)),
  );
  return files
    .filter((name): name is string => name !== null)
    .map((name) => name.split(sep).join("/"))
    .sort();
}

/** One labeled input, length-prefixed so two inputs can never run into each other. */
function feed(hash: Hash, label: string, bytes: Buffer | string): void {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  hash.update(`${label}\0${buffer.length}\0`);
  hash.update(buffer);
}

/**
 * The `PITHY_PRIVACY` attestation without the time it was written. Every `pithy deploy` dates a fresh one, so
 * the date alone would make every run a change; the classes and the gate's verdict are configuration.
 */
function undatedAttestation(value: string): string {
  try {
    const { attestedAt: _, ...rest } = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify(canonicalize(rest));
  } catch {
    return value;
  }
}

/** The argv as an input: any stamp it already carries left out of its own hash, the attestation undated. */
function argvInput(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = arg === "--var" ? (args[index + 1] ?? "") : "";
    if (value.startsWith(`${DEPLOY_STAMP_VAR}:`)) {
      index += 1;
      continue;
    }
    if (value.startsWith(`${PRIVACY_ATTESTATION_VAR}:`)) {
      index += 1;
      out.push(
        arg,
        `${PRIVACY_ATTESTATION_VAR}:${undatedAttestation(value.slice(PRIVACY_ATTESTATION_VAR.length + 1))}`,
      );
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** The assets directory the selected stanza names, resolved against the configuration's own directory. */
function assetsDirectory(configPath: string, config: WranglerShape, stanza: WranglerShape): string | undefined {
  const named = (shape: WranglerShape): unknown => (shape as { assets?: { directory?: unknown } }).assets?.directory;
  const directory = named(stanza) ?? named(config);
  if (typeof directory !== "string" || directory === "") return undefined;
  return isAbsolute(directory) ? directory : resolve(dirname(configPath), directory);
}

/** The stamp one app Worker's deploy would write, from the bundle wrangler wrote to `outdir`. */
export async function appBundleStamp(options: AppBundleOptions): Promise<AppBundle> {
  const normalize = options.normalize ?? ((text: string) => text);
  const effective = await effectiveDeployConfig(options.workerDir, options.args);
  const raw = await readOptionalFile(effective.path);
  const config = (raw === null ? {} : (parse(normalize(raw)) as unknown as WranglerShape)) ?? {};
  const selected = selectedEnvironment(options.args, options.processEnv);
  const { name } = identityOf(effective.path, config, selected, effective.redirected);
  const stanza = effective.redirected ? config : stanzaOf(config, selected);

  const hash = createHash("sha256");
  feed(hash, "config", JSON.stringify(canonicalize(config)));
  feed(hash, "stanza", selected ?? "");
  feed(hash, "argv", normalize(JSON.stringify(argvInput(options.args))));
  for (const path of (await filesUnder(options.outdir)).filter(bundled)) {
    const bytes = await readFile(join(options.outdir, path));
    feed(hash, `bundle:${path}`, TEXT.test(path) ? normalize(bytes.toString("utf8")) : bytes);
  }
  const assets = assetsDirectory(effective.path, config, stanza);
  if (assets !== undefined) {
    for (const path of await filesUnder(assets)) feed(hash, `asset:${path}`, await readFile(join(assets, path)));
  }
  return { scriptName: name, stamp: hash.digest("hex").slice(0, STAMP_LENGTH) };
}

/** The `../` prefix that leads from `from` to `to`, ending in a separator, or empty when they are one place. */
function prefix(from: string, to: string): string {
  const rel = relative(from, to).split(sep).join("/");
  return rel === "" ? "" : `${rel}/`;
}

/**
 * The normalizer for a bundle written in a copy of the project.
 *
 * The copy links `node_modules` back to the project and esbuild follows the link, so a dependency's path comment
 * leads from the copy's Worker directory out to the project, where the project's own bundle leads straight up.
 * Both prefixes are taken between real paths, as esbuild takes them; then every absolute mention of the copy is
 * put back to the project.
 */
export async function shadowBundlePaths(
  shadow: { root: string; toProject: (text: string) => string },
  projectDir: string,
  shadowWorkerDir: string,
): Promise<(text: string) => string> {
  const real = async (path: string) => realpath(path).catch(() => path);
  const project = await real(projectDir);
  const copyWorker = await real(shadowWorkerDir);
  const projectWorker = await real(shadow.toProject(shadowWorkerDir));
  const from = prefix(copyWorker, project);
  const to = prefix(projectWorker, project);
  return (text) => shadow.toProject(from === "" ? text : text.split(from).join(to));
}
