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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CleanRoomManifest,
  cleanRoomEnv,
  isStalledStep,
  kitOverrides,
  STEP_TIMEOUT_MS,
  stalledStep,
  thirdPartyFloors,
} from "@pithy-sh/release/src/cleanRoom";
import { composedResult } from "@pithy-sh/release/src/composed";
import { publishedPackages } from "@pithy-sh/release/src/workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const atFloors = process.argv.includes("--floors");

/**
 * Every command the gate runs: in the workspace, on the workspace's own installer cache, and bounded.
 *
 * **`cleanRoomEnv` is the third assumption the clean room removes** — see `@pithy-sh/release/src/cleanRoom`
 * for the measurements. A shared package-manager cache is "everything else on disk" wearing a different
 * hat, and a half-warm one deadlocks `bun add` at the declared floors.
 *
 * **`timeout` is what makes a deadlock reportable.** Without it the only bound on a wedged child was the
 * CI runner's own limit, so the gate held a job for 1h42m and then said nothing. `SIGKILL` rather than
 * the default `SIGTERM`: a process parked in `epoll_wait` on nothing is not going to run a handler.
 */
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...cleanRoomEnv(workspace), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function fail(what: string, cause: unknown): never {
  // A stall carries no output and no exit code, so `cause.message` is `spawnSync bun ETIMEDOUT` and
  // nothing else. `stalledStep` says what that actually means instead.
  const said = isStalledStep(cause)
    ? stalledStep(what, STEP_TIMEOUT_MS)
    : cause instanceof Error
      ? cause.message
      : String(cause);
  process.stderr.write(`\nClean room failed: ${what}\n\n${said}\n\n`);
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "pithy-cleanroom-"));
const packs = join(workspace, "packs");
const project = join(workspace, "project");
// The installer cache among them, so it is visibly part of the workspace rather than a directory some
// child happens to create — and so it goes when the workspace goes.
run("mkdir", ["-p", packs, project, ...Object.values(cleanRoomEnv(workspace))], root);

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

  /** A fresh, empty, git-initialized directory — what `pithy init` requires and an adopter starts from. */
  const emptyProject = (name: string): string => {
    const dir = join(workspace, name);
    run("mkdir", ["-p", dir], root);
    run("git", ["init", "-q", "."], dir);
    return dir;
  };

  const app = emptyProject("app");
  const drive = (what: string, args: string[], cwd: string, env: Record<string, string> = {}): void => {
    process.stdout.write(`  ${what}\n`);
    try {
      run(pithy, args, cwd, env);
    } catch (cause) {
      fail(what, cause);
    }
  };

  drive("pithy --version", ["--version"], project);
  drive("pithy init", ["init", "--name", "cleanroom", "--worker", "api"], app);

  // **The scaffolded project installs its own dependencies before anything reads its config, because
  // that is the sequence an adopter follows and the one Bun was hiding — #474.** `pithy init` refuses
  // a directory that already has a `package.json`, so the scaffold cannot happen where the kit is
  // already installed; it writes the manifest, and the install comes after it.
  //
  // Skipping that step used to pass. Asked to load the Worker's `pithy.config.ts`, which imports
  // `@pithy-sh/core`, Bun resolves a bare specifier from the importer that reached it — so it found the
  // core beside the CLI, in a different directory tree, and `pithy ui add react` succeeded against a
  // project that had installed nothing. Node resolves from the config's own directory upward, finds
  // nothing, and `pithy` reports exactly that. Node is right, the fixture was wrong, and only a CLI
  // started by node could say so.
  //
  // The overrides go on again here: this manifest names published ranges, and without them the install
  // would fetch the last release and the gate would drive that instead of what is about to ship.
  const scaffolded = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(app, "package.json"), `${JSON.stringify({ ...scaffolded, overrides }, null, 2)}\n`);
  process.stdout.write("  install the scaffolded project\n");
  try {
    run("bun", ["install"], app);
  } catch (cause) {
    fail("installing the project pithy init scaffolded", cause);
  }

  drive("pithy ui add react", ["ui", "add", "react", "--worker", "api"], app);

  // **The capability lifecycle, which nothing above reaches — #480, #483.**
  //
  // Everything before this drives `init` and `ui add`. `pithy add <capability>` is the command an
  // adopter runs next, several times, and it was unasserted end to end: both open issues found against
  // 0.1.2 live in it, and so do two promises the capability contract makes and nothing checks.
  //
  // **Every add runs once, and a failure is a failure.** Not retried — retrying is exactly what hid
  // #480, where a capability declared on the wrong `package.json` loses a race with its own install and
  // then succeeds on a second attempt because the failed run left the package on disk. A bug that
  // survives one attempt and not two is invisible to a suite that retries, and it is the shape an
  // adopter meets on their first day and a maintainer never reproduces.
  //
  // **The set is the one `pithy-sh/dashboard` actually composes**, not a sample. Its first-run suite
  // reported `email audit auth payments support turnstile` failing against 0.1.2, and a gate that drove
  // four of those six would have been answering a narrower question than the one being asked of it.
  // `auth` and `support` cost a few seconds each and close that gap.
  //
  // In prerequisite order, and that order is itself a finding: `email` requires `secrets` and `auth`
  // requires `email`, so the chain is real and the CLI refuses to compose one out of turn — naming the
  // command that fixes it. The reordered pass below carries `--with-prerequisites` precisely because
  // this order cannot simply be reversed.
  const CAPABILITIES = ["secrets", "email", "auth", "audit", "support", "i18n"];
  for (const capability of CAPABILITIES) {
    drive(`pithy add ${capability}`, ["add", capability, "--worker", "api"], app);
  }

  // **A capability is declared on the Worker whose config imports it.** `pithy add` writes the import
  // into `apps/api/pithy.config.ts`, so that is where the dependency belongs — which is where `init`
  // already puts `@pithy-sh/core`. Declared at the root instead, it only resolves because most package
  // managers hoist; under bun's isolated linker `apps/api/node_modules` receives what `apps/api`
  // declares and nothing else.
  //
  // Read off the manifests rather than inferred from a successful command, because hoisting means the
  // command succeeds either way on most machines. The placement is the property; the failure is
  // downstream of it and only on some installers.
  const declared = (manifest: string): string[] =>
    Object.keys(
      (JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {},
    ).filter((name) => name.startsWith("@pithy-sh/"));

  const onWorker = declared(join(app, "apps", "api", "package.json"));
  const onRoot = declared(join(app, "package.json"));
  const missing = CAPABILITIES.map((name) => `@pithy-sh/${name}`).filter((name) => !onWorker.includes(name));
  if (missing.length > 0) {
    fail(
      "declaring capabilities on the Worker that imports them",
      `apps/api/package.json is missing ${missing.join(", ")}.\n` +
        `  apps/api declares: ${onWorker.join(" ") || "(none)"}\n` +
        `  the root declares: ${onRoot.join(" ") || "(none)"}\n\n` +
        "The import goes into apps/api/pithy.config.ts, so the dependency belongs beside it.",
    );
  }
  process.stdout.write(`  capabilities declared on the Worker: ${onWorker.length}\n`);

  /**
   * What a scaffolded Worker is composed of, as a set — capabilities plus `<env>:<binding>`.
   *
   * **Refuses an empty answer rather than returning one.** `pithy-sh/dashboard` ran this comparison
   * with an argv slip that made both extractions empty; two empty lists compared equal and the suite
   * reported that the property held. A probe that silently reads nothing is a permanently green gate,
   * and that is the failure mode which hides exactly the class of bug this file is for. The floor is
   * here, on the probe, rather than only on the comparison below.
   */
  const composedOf = (project: string, label: string): string[] => {
    const worker = join(project, "apps", "api");
    const result = composedResult(
      readFileSync(join(worker, "pithy.config.ts"), "utf8"),
      readFileSync(join(worker, "wrangler.jsonc"), "utf8"),
    );
    if (result.length === 0)
      fail(
        `reading what ${label} composes`,
        `${worker} composes nothing — the probe read no capabilities and no bindings.`,
      );
    return result;
  };

  const composedInOrder = composedOf(app, "the first project");

  // **A choice that needs code is written with its seam, not refused — #500, over #483's property.**
  //
  // `--set billingSubject=organization` used to be refused, because `pithy add` renders JSON and cannot
  // render a function, and writing the value without the function left a config the kit refuses to load
  // — which failed every later command in the project (#483). The refusal was correct and the path out
  // of it was not: the only way to organization billing ran through declaring `user`, a value wrong for
  // the project, and editing it afterwards.
  //
  // It is now accepted, and the seam is scaffolded beside it. Three things matter and each is asserted
  // separately, because any one of them can hold while another breaks: the add **succeeds**, the project
  // is **still loadable** afterwards (#483's half, now proved positively rather than by refusing), and a
  // re-run **never overwrites a seam the adopter has implemented**.
  drive(
    "pithy add payments --set billingSubject=organization",
    ["add", "payments", "--worker", "api", "--set", "billingSubject=organization"],
    app,
  );

  const seam = join(app, "apps", "api", "src", "billing", "subject.ts");
  if (!existsSync(seam)) {
    fail("scaffolding the billing subject seam", "apps/api/src/billing/subject.ts was not written.");
  }
  const wired = readFileSync(join(app, "apps", "api", "pithy.config.ts"), "utf8");
  for (const [what, needle] of [
    ["the seam import", "./src/billing/subject"],
    ["the resolveSubject binding", "resolveSubject"],
    ["the value the adopter asked for", '"organization"'],
  ] as const) {
    if (!wired.includes(needle)) {
      fail("wiring the billing subject seam", `apps/api/pithy.config.ts carries no ${what} (${needle}).`);
    }
  }

  // The project is still usable, which is the half #483 is about: a config the kit cannot load fails
  // every later command, so the next add is what proves this one left a loadable project behind.
  drive("pithy add turnstile (after the seam)", ["add", "turnstile", "--worker", "api"], app);

  // **Idempotency, which `addCapability` states as a contract and nothing checked.** "A second run
  // changes nothing" is what lets CI re-run a manifest and a script re-apply one; it is also what makes
  // a half-finished run recoverable. Asserted by re-adding everything and diffing the files an add writes.
  //
  // Re-running carries no `--set`, deliberately: the answer is already committed to `pithy.config.ts`,
  // and a re-run that demanded it again would fail where the first run succeeded.
  const wiring = (): Record<string, string> =>
    Object.fromEntries(
      ["pithy.config.ts", "wrangler.jsonc", "package.json"].map((file) => [
        file,
        readFileSync(join(app, "apps", "api", file), "utf8"),
      ]),
    );

  const before = wiring();
  // The floor, for the reason `composedOf` carries one: two identical readings of nothing compare equal
  // and report that idempotency holds. Every one of these files has content and names the Worker's own
  // capabilities, so an empty or truncated read is a broken probe rather than a passing gate.
  for (const [file, text] of Object.entries(before)) {
    if (text.trim() === "") fail("reading the Worker's wiring", `apps/api/${file} read as empty.`);
  }
  if (!before["pithy.config.ts"]?.includes("@pithy-sh/secrets")) {
    fail("reading the Worker's wiring", "apps/api/pithy.config.ts names no capability that was just added.");
  }

  process.stdout.write("  every add again, changing nothing\n");
  for (const capability of [...CAPABILITIES, "turnstile", "payments"]) {
    drive(`  re-add ${capability}`, ["add", capability, "--worker", "api"], app);
  }
  const after = wiring();
  const moved = Object.keys(before).filter((file) => before[file] !== after[file]);
  if (moved.length > 0) {
    fail(
      "re-adding every capability",
      `a second run rewrote ${moved.join(", ")}. \`pithy add\` is idempotent by contract — CI re-runs it.`,
    );
  }

  // **The same capabilities in the opposite order compose the same result — #486.**
  //
  // "Additive" promises that the *result* is the same, not that the file is: every writer in the CLI's
  // `capabilities/add.ts` appends, so two orderings legitimately produce the same set in a different
  // textual order. A byte diff was the first version of this check and it was refused, because a gate
  // that fails on correct behavior gets switched off and takes the real assertions with it.
  //
  // Appending is *why* it holds today, which is the argument for not asserting it — and the argument
  // against that is that whether every writer appends is the thing under test rather than a premise of
  // it. `add.ts` has several writers, a capability added later can interact with another, and this is
  // the one promise in the capability contract that has never been observed to hold.
  //
  // The bindings carry their environment, so a binding landing in `staging` and not `prod` is a
  // difference even when the overall set of names matches.
  const reordered = emptyProject("app-reordered");
  drive("pithy init (reordered)", ["init", "--name", "reordered", "--worker", "api"], reordered);
  const reorderedManifest = JSON.parse(readFileSync(join(reordered, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(join(reordered, "package.json"), `${JSON.stringify({ ...reorderedManifest, overrides }, null, 2)}\n`);
  try {
    run("bun", ["install"], reordered);
  } catch (cause) {
    fail("installing the reordered project", cause);
  }
  // `--with-prerequisites`, because the reverse order is not otherwise reachable and that is correct
  // behavior rather than a defect: `email` requires `secrets`, so adding it first is refused naming the
  // command that fixes it. The first version of this check took that refusal for a failure. Resolving
  // prerequisites is itself deterministic, so the comparison still asks one question — whichever route
  // a project takes to composing these four, it ends up composed of the same things.
  for (const capability of [...CAPABILITIES].reverse()) {
    drive(`  add ${capability} (reordered)`, ["add", capability, "--worker", "api", "--with-prerequisites"], reordered);
  }

  const composedReversed = composedOf(reordered, "the reordered project");
  if (composedInOrder.join("\n") !== composedReversed.join("\n")) {
    const onlyFirst = composedInOrder.filter((one) => !composedReversed.includes(one));
    const onlySecond = composedReversed.filter((one) => !composedInOrder.includes(one));
    fail(
      "composing the same result whichever order the adds arrived in",
      `the two projects differ.\n` +
        `  only in the first order:  ${onlyFirst.join(" ") || "(nothing)"}\n` +
        `  only in the reverse:      ${onlySecond.join(" ") || "(nothing)"}`,
    );
  }
  process.stdout.write(`  the same ${composedInOrder.length} composed either way\n`);

  // **A seam already on disk is the adopter's, and a scaffold never writes over it.**
  //
  // The file `pithy add` writes is the file the adopter is asked to replace, so an add that rewrote it
  // would silently destroy real work — a worse failure than the detour #500 removed, and the one thing
  // that would have made keeping that detour the better trade.
  //
  // **Shaped as a fresh registration over an existing file, because that is the only shape that can
  // fail.** Re-running the add in a project that already composes payments is protected several times
  // over — the run carries no seam, and the registration is already there — so removing the writer's own
  // existence check leaves such a check passing. Measured: with both of those removed, the re-run
  // version of this assertion still passed, which made it worth nothing. Here the registration is new,
  // so the seam is genuinely requested and the writer's check is the only thing standing between the
  // adopter's resolver and the placeholder.
  const adopterSeam = join(reordered, "apps", "api", "src", "billing", "subject.ts");
  const implemented = '// the adopter\'s own resolver.\nexport const resolveSubject = async () => "org_1";\n';
  mkdirSync(dirname(adopterSeam), { recursive: true });
  writeFileSync(adopterSeam, implemented);

  drive(
    "pithy add payments --set billingSubject=organization (over an implemented seam)",
    ["add", "payments", "--worker", "api", "--set", "billingSubject=organization"],
    reordered,
  );

  if (readFileSync(adopterSeam, "utf8") !== implemented) {
    fail(
      "adding payments over an implemented seam",
      "apps/api/src/billing/subject.ts was overwritten. That silently destroys the adopter's own code.",
    );
  }

  // **The same commands again with Bun removed from PATH — #474.** `bin` was `./src/bin.ts` behind
  // `#!/usr/bin/env bun`, so `pithy` installed for everyone and started for nobody without Bun:
  // `/usr/bin/env: 'bun': No such file or directory`. Nothing in this repository could see it. Every
  // gate ran where Bun is always installed, and every consumer was a symlink to the checkout until
  // 0.1.0 — a symlinked package resolves by realpath, outside `node_modules`, where the shebang is not
  // what starts it. The dashboard found it on the first gate it ran after unlinking.
  //
  // A PATH built from scratch rather than filtered, because a filter has to guess every directory a
  // Bun might sit in — `~/.bun/bin`, a Homebrew prefix, a Volta shim, whatever a CI image did. So this
  // makes a directory containing one thing, a link to the real `node`, and puts that in front of the
  // two standard ones.
  //
  // `which node`, never `process.execPath`: this script is itself run by Bun, so the running
  // executable's directory is exactly the one that has to be excluded — including it reintroduced
  // `~/.bun/bin` and the sandbox contained the thing it was built to exclude.
  //
  // And then it proves Bun is unreachable rather than assuming so. A `bun` that survived the pruning —
  // one installed into `/usr/bin`, say — would make every assertion below vacuous while still printing
  // that it passed, which is the failure mode a gate like this exists to avoid having.
  const nodeBin = join(workspace, "node-only");
  run("mkdir", ["-p", nodeBin], root);
  const realNode = run("which", ["node"], root).trim();
  if (realNode === "") fail("locating node", "`which node` found nothing; this gate needs a real node");
  run("ln", ["-s", realNode, join(nodeBin, "node")], root);

  const withoutBun = { PATH: `${nodeBin}:/usr/bin:/bin` };
  let bunSurvived = false;
  try {
    run("bun", ["--version"], project, withoutBun);
    bunSurvived = true;
  } catch {
    // Expected: this is the sandbox working.
  }
  if (bunSurvived) fail("removing bun from PATH", `bun is still reachable through ${withoutBun.PATH}`);

  // A second scaffold directory, because `pithy init` is not idempotent over a project it has already
  // written, so reusing `app` would test the refusal rather than the scaffold.
  const noBunApp = emptyProject("app-no-bun");
  process.stdout.write("  the same, with bun off PATH\n");
  drive("pithy --version (no bun)", ["--version"], project, withoutBun);
  drive("pithy init (no bun)", ["init", "--name", "nobun", "--worker", "api"], noBunApp, withoutBun);

  // **Exactly one copy of each shared runtime, which is the property #477 is about.**
  //
  // `zod`, `kysely` and `hono` are `peerDependencies` of every package that imports them, so an
  // installer puts one at the top where the adopter's own import finds it too. Two copies of a package
  // whose classes carry private members are two different types, and the diagnostic never says so:
  // `Type 'Kysely<any>' is not assignable to type 'Kysely<any>'` with both paths reading identically.
  // `pithy-sh/dashboard` lost a day to it moving off a linked checkout onto published 0.1.2.
  //
  // Counted in the installed tree rather than argued from the manifests, because the manifests are what
  // `sharedRuntimeDeps.test.ts` already checks and a resolver is free to disagree with them. Nesting is
  // what a duplicate looks like on disk: a second copy appears under some package's own `node_modules`.
  process.stdout.write("  one copy of each shared runtime\n");
  for (const name of ["zod", "kysely", "hono"]) {
    const copies = run("find", [join(project, "node_modules"), "-type", "d", "-name", name], root)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(`node_modules/${name}`) && existsSync(join(line, "package.json")))
      .map((line) => relative(project, line));

    if (copies.length !== 1) {
      fail(
        `resolving ${name} to one copy`,
        `${copies.length} copies installed:\n  ${copies.join("\n  ")}\n\n` +
          `Two copies are two types. Check that every package importing ${name} declares it in peerDependencies at one range.`,
      );
    }
  }

  // **The scaffolded project can load the kit it composes — the blind spot that shipped 0.1.3.**
  //
  // Everything above installs the kit into `project` and drives `pithy` from there. That is the
  // *toolchain*, and it is not what an adopter builds: `pithy dev`, `wrangler deploy` and `vite build`
  // all resolve from `apps/<worker>`, where the capabilities were declared and where their dependencies
  // have to be satisfiable. Nothing checked that, so the peer-dependency change in #477 shipped with
  // half of itself missing — `zod` and `kysely` were peers of every capability, npm installs a peer at
  // the top and bun, for a workspace member, does not, and a scaffolded Worker could not load
  // `@pithy-sh/core` at all. Measured on published 0.1.3, from `apps/board`:
  // `ERR_MODULE_NOT_FOUND: Cannot find package '@pithy-sh/core'`.
  //
  // Asked of the Worker directory rather than the project root, because that is the only place the
  // answer differs — and it is `node`, for the reason the probe below is: a bundler would resolve this
  // for itself and never notice.
  process.stdout.write("  the scaffolded Worker loads what it composes\n");
  const workerDir = join(app, "apps", "api");
  for (const specifier of ["@pithy-sh/core/src/error/pithyError", "@pithy-sh/auth/src/capability", "zod", "kysely"]) {
    try {
      run("node", ["-e", `await import(${JSON.stringify(specifier)})`], workerDir);
    } catch (cause) {
      fail(
        `loading ${specifier} from the scaffolded Worker`,
        `${cause instanceof Error ? cause.message : String(cause)}\n\n` +
          "apps/api composes this capability. Whatever it declares must be resolvable from there — a peer\n" +
          "the Worker does not declare is installed by npm and not by bun.",
      );
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
