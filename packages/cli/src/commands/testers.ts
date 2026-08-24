// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import type { EmailMessageLayers } from "@pithy-sh/email/src/templates/messages";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createCliAudit } from "../audit/cliAudit";
import { classifyCapabilityLoadFailure } from "../capabilities/loadFailure";
import { loadTesters } from "../capabilities/testersLoader";
import { CloudflareTestersProvisioner, loadTestersProvisioning } from "../capabilities/testersProvisioner";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment, requireManagedEnvironment } from "../project/environment";
import { composedProjectCapabilities, projectCapabilities, resolveWorkers } from "../project/workerScope";
import { openSeedDriver } from "../seed/drivers";
import { createCliLogger } from "../terminal/logger";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim, saffron } from "../terminal/style";

/**
 * The sending identity the deployed daily-pass host is stamped with. Referenced by type only, the way
 * `capabilities/testersProvisioner.ts` does, so the CLI gains no dependency on the optional package.
 */
type TestersEmailIdentity = import("@pithy-sh/testers/src/provision/resolveTestersConfig").TestersEmailIdentity;

/**
 * `pithy testers` — run a closed test from the terminal.
 *
 * **The dashboard is the paid tier; this is not.** A developer with no dashboard has to be able to
 * create a cohort, invite people, see where they stand, and chase whoever needs chasing, or the
 * capability is a library that only works if you buy something. So every operation the control-plane
 * routes expose has a command here, each non-interactive and each `--json`.
 *
 * **These read and write the database directly rather than calling the Worker over HTTP.** The routes
 * exist for a management client that holds a control-plane credential; a developer at a terminal in
 * their own repo already has the database, and making them mint a token to read their own roster would
 * be ceremony with no security benefit. `dev` resolves through Miniflare against the same
 * `.wrangler/state` `pithy dev` uses; every other environment resolves over the REST client keyed by
 * that environment's `wrangler.jsonc` ids — the same seam `pithy seed` runs on.
 *
 * Every figure these print about opt-ins is Pithy's estimate from its own invite records. Google's
 * count is authoritative and no API exposes it, and the closing line of every status output says so.
 */

/** The sentence that closes every human-readable status output. */
const ESTIMATE_NOTE = [
  "This is Pithy's estimate from your own invite records.",
  "Google's count is authoritative and no API exposes it.",
].join("\n");

/**
 * A required positional, or an actionable error.
 *
 * Citty types every positional as possibly absent, and a cast would turn a missing cohort name into
 * `undefined` reaching a database query — which fails as a 404 for a cohort nobody named. Failing here
 * says what is missing instead.
 */
function required(value: string | undefined, name: string, example: string): string {
  if (value === undefined || value.trim() === "") {
    throw new ValidationError({
      message: `Missing ${name}.`,
      action: `Pass it: ${example}`,
    });
  }
  return value;
}

/**
 * A flag that must be a whole positive number.
 *
 * `Number("twelve")` is `NaN`, and nothing downstream rejects it usefully: a `NaN` target size reaches
 * `TestersCohort.encode` and surfaces as a raw `ZodError` from inside the data layer, and a `NaN` limit
 * reaches Kysely's `.limit()` and then D1. Both name the schema field rather than the flag the user
 * typed. Caught here, the answer names the flag.
 */
function wholeNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError({
      message: `${flag} must be a whole number above zero. Got ${JSON.stringify(value)}.`,
      action: `Pass a number: ${flag} ${fallback}`,
    });
  }
  return parsed;
}

/**
 * A flag that must be one of a fixed set.
 *
 * The alternative is a cast, which types the value without checking it and moves the failure to
 * whichever schema eventually parses it — `--platform windows` became a `ZodError` on `targetPlatform`
 * raised inside `createCohort`, well away from the flag that caused it.
 */
function oneOf<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  flag: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) {
    throw new ValidationError({
      message: `${flag} must be one of ${allowed.join(", ")}. Got ${JSON.stringify(value)}.`,
      action: `Pass a supported value: ${flag} ${allowed[0]}`,
    });
  }
  return value as T[number];
}

/**
 * `--env` here is two different sets, deliberately. The roster subcommands take {@link ENV_ARG} and
 * default to `dev`, because they talk to a local D1 and dev is where you use them. Provisioning deploys
 * a Worker to a Cloudflare account, where there is no dev to deploy to, so it goes through
 * {@link requireManagedEnvironment} instead. Both refuse an illegal environment as a `ValidationError`;
 * neither lets a bare `ZodError` escape `withErrorReporting` with a stack trace.
 */

/**
 * A name within the deployment's configured ceiling.
 *
 * The HTTP schema has its own bound; this is the project's, which may be tighter, and the CLI had
 * neither — `pithy testers create` passed whatever it was handed straight to an unbounded `text`
 * column. `maxNameLength` was described as "the longest cohort or tester name accepted" and read by
 * nothing on any path.
 */
function boundedName(value: string, limit: number, flag: string): string {
  if (value.length > limit) {
    throw new ValidationError({
      message: `That ${flag} is longer than this deployment allows.`,
      action: `Keep it under ${limit} characters.`,
      detail: `${flag} was ${value.length}, limit ${limit}`,
    });
  }
  return value;
}

/**
 * The logger every read command hands to `readCohort`.
 *
 * Not optional in practice. When the activity read fails — auth resolvable but its tables absent, or a
 * transient D1 error — the whole roster degrades to "never signed in", which reads exactly like a cohort
 * nobody ever used. Without a logger that degradation reaches the terminal as a plausible answer with no
 * trace of why. `createCliLogger` writes to `stderr` at `warn`, so the line shows without `--debug` and
 * the `--json` contract on `stdout` is untouched.
 */
function readerLog(json: boolean): Logger {
  return createCliLogger({ json }).child("testers");
}

/** Resolve the app D1 for an environment, plus the resolved testers config. */
async function openTesters(requested: string) {
  // The roster commands' one door, so the `--env` check lives here rather than nine times over.
  const env = requireEnvironment(requested);
  const projectDir = process.cwd();
  const workers = await resolveWorkers({ projectDir });
  const { isTestersCapability } = await loadTesters();
  const capability = projectCapabilities(workers).find(isTestersCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The testers capability is not configured.",
      action: "Add `testers({ baseUrl: '...' })` to pithy.config.ts (run `pithy add testers`).",
    });
  }
  // Capabilities live per Worker; the roster is one project-wide thing, so the first Worker composing
  // testers supplies both the config and the database binding.
  const worker = workers.find((entry) => entry.capabilities?.some(isTestersCapability)) ?? workers[0];
  if (!worker) {
    throw new ValidationError({
      message: "No Worker composes the testers capability.",
      action: "Run `pithy add testers --worker <name>` first.",
    });
  }

  // The account this project belongs to, before the driver resolves a credential. For any env but
  // `dev` this driver is a REST client writing into a real D1 and a real R2, and `openSeedDriver`'s own
  // doc comment calls this the guard against putting this project's rows in another company's tenant
  // (#206). `buildProvisioner` below has named its account since then; this door had not.
  const driver = await openSeedDriver({
    workerDir: worker.dir,
    persistRoot: projectDir,
    env,
    account: await projectCloudflareAccount(projectDir),
  });
  const modules = await loadTesters();
  return {
    driver,
    d1: driver.d1("DB"),
    db: modules.testersDatabase(driver.d1("DB")),
    config: capability.testersConfig,
    modules,
    enqueue: await buildEnqueue(workers, driver.d1("DB")),
  };
}

/**
 * What a failed optional email import is classified *as*. The package half is what decides "ours or
 * theirs"; the subpath is `detail` only.
 */
const EMAIL_MODULE = "@pithy-sh/email/src/capability";

/**
 * Run an optional `@pithy-sh/email` import, answering `undefined` **only** for a package that is
 * genuinely absent (#230).
 *
 * Email really is optional to `pithy testers`: a project that composes none still advances the roster,
 * records the day, and writes its snapshot — it just sends nothing, and both call sites say so. So
 * `undefined` is a real answer and not a swallowed error.
 *
 * But it is one of four answers this import can give, and the other three mean the package is right
 * there: a dependency of its own that does not resolve, an export map that does not, and source that
 * will not parse. Two bare `catch { … undefined }` blocks answered all four the same way, and the run
 * then reported `sends: false` and printed *"no email capability is configured in this project"* about
 * a capability the adopter had installed. Nothing in the output was a lie the adopter could catch: the
 * one fact that would have told them apart was in the caught error, discarded a frame later.
 *
 * That is `docs/CONVENTIONS.md` §Refusals — **a `catch` reachable by more than one underlying failure
 * may not name a single specific remedy** — and {@link classifyCapabilityLoadFailure} is the function
 * #217 left for it. Exported so it is tested as a pure function against both runtimes' cause shapes,
 * per the same convention: the `bin` runs on Bun, whose resolver errors are not `instanceof Error`.
 */
export async function loadOptionalEmail<T>(load: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    const failure = classifyCapabilityLoadFailure("email", EMAIL_MODULE, error);
    // The only absence there is. Everything else is a fault, and a fault that reads as an absence is
    // the defect this exists to remove.
    if (failure.kind === "not-installed") return undefined;
    throw new ValidationError(
      { message: failure.message, action: failure.action, detail: failure.detail },
      { cause: error },
    );
  }
}

/**
 * The email enqueue seam, built from the project's own email configuration.
 *
 * **The CLI needs no sending domain of its own.** `enqueueEmail` writes a row into `pithy_email_jobs`;
 * the email worker that already exists for any project using auth is what actually delivers it. So the
 * only thing needed here is the from-identity and the theme, and both are readable off the email
 * capability in `pithy.config.ts` — no secret, no deployed worker, and it works against any environment.
 *
 * Returns `undefined` when email is not composed, so the pass still advances state and records the day
 * rather than failing over a dependency this path can do without. **Not composed and not installed are
 * the only two silences** — see {@link loadOptionalEmail} for why an installed-and-broken package is
 * not a third.
 */
export async function buildEnqueue(workers: Awaited<ReturnType<typeof resolveWorkers>>, d1: D1Database) {
  const modules = await loadOptionalEmail(async () => ({
    ...(await import("@pithy-sh/email/src/capability")),
    ...(await import("@pithy-sh/email/src/send/enqueue")),
    ...(await import("@pithy-sh/email/src/data/tables")),
  }));
  if (!modules) return undefined;
  const { isEmailCapability, enqueueEmail, emailDatabase } = modules;

  // **Assembled, not merely collected.** `layersFor` below is a value an i18n capability fills in its
  // `compose` hook, and reading it off an unassembled capability is silent: the layers are all empty,
  // so every kit `email/*` key renders as its own key string and this command mails a footer link
  // labeled `email/shell.unsubscribe`. Worse than the English it replaced, because `enqueueEmail`
  // falls back to the kit's own catalogs when it is handed no `layersFor` at all — so adding `i18n()`
  // broke a path that was correct without it. See `capabilities/compose.ts`.
  const capabilities = composedProjectCapabilities(workers);

  const email = capabilities.find(isEmailCapability);
  if (!email) return undefined;

  const config = email.emailConfig;
  /**
   * The language a nudge goes out in: the project's default, and nothing narrower.
   *
   * This runs from a terminal. There is no request to negotiate from and no per-tester preference on a
   * roster row, so the only truthful answer is the language the project itself declares — which is what
   * the composed `i18n` capability's `defaultLocale` is. Duck-typed off the composed set rather than
   * imported, because `@pithy-sh/i18n` is optional and the CLI must not hard-depend on a capability an
   * adopter may never add; absent, the nudge is written in the kit's English exactly as before.
   *
   * It moves the shell only. A nudge's words are supplied per message by whoever asked for it, so this
   * decides the document's `lang` and `dir` and the footer, not the letter.
   */
  const i18n = capabilities.find(
    (candidate): candidate is Capability & { layersFor: EmailMessageLayers; i18nConfig: { defaultLocale: string } } =>
      candidate.name === "i18n" &&
      typeof (candidate as { layersFor?: unknown }).layersFor === "function" &&
      typeof (candidate as { i18nConfig?: { defaultLocale?: unknown } }).i18nConfig?.defaultLocale === "string",
  );
  return async (input: { to: string; template: string; payload: unknown }) =>
    enqueueEmail(
      {
        db: emailDatabase(d1),
        fromAddress: config.fromAddress,
        fromName: config.fromName,
        // Already resolved on the capability — the preset and any overrides were merged at assembly.
        theme: config.theme,
        ...(i18n ? { layersFor: i18n.layersFor } : {}),
        // No send-Workflow binding from a terminal, so the row stays `pending` and the email worker's
        // every-minute scheduler picks it up. Slower by up to a minute, and it loses nothing.
        sender: undefined,
        now: new Date(),
        newId: () => crypto.randomUUID(),
      },
      i18n ? { ...input, locale: i18n.i18nConfig.defaultLocale } : input,
    );
}

/**
 * Build the live provisioner for a project.
 *
 * The sending identity is read off the composed email capability rather than asked for: the adopter has
 * already told `pithy.config.ts` which domain they send from, and asking twice is how the two drift.
 *
 * The project name comes from `requireProjectName`, never `resolveProjectName`: it leads the deployed
 * host name and the suppression database this looks up, and both have to be the same names the other
 * commands compute (docs/NAMING.md).
 */
async function buildProvisioner(projectDir: string) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const config = await loadProject(projectDir);
  const project = requireProjectName(config);
  // The project's own environment set (#241), carried rather than assumed.
  const environments = loadProjectEnvironments(config);
  const selection = await projectCloudflareAccount(projectDir);
  const vars = cloudflareEnv({ account: selection });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  // What vouches for that id (#378). The host teardown reads a missing Worker as "already gone", and an
  // account nothing claims answers exactly that way about a host that is still running.
  const account: ConfirmedAccount = { accountId, confirmation: cloudflareAccountConfirmation({ account: selection }) };
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }

  const workers = await resolveWorkers({ projectDir });
  // Assembled, for the same reason the enqueue seam above is: the catalogs stamped into the deployed
  // host come off `hostCatalogs()`, which answers `{}` until every `compose` hook has run.
  const capabilities = composedProjectCapabilities(workers);
  const { isTestersCapability } = await loadTesters();
  const testers = capabilities.find(isTestersCapability);
  if (!testers) {
    throw new ValidationError({
      message: "The testers capability is not configured.",
      action: "Add `testers({ baseUrl: '...' })` to pithy.config.ts (run `pithy add testers`).",
    });
  }

  // Undefined when no email capability is composed. The pass then advances state and writes its
  // snapshot but sends nothing — a real state, and better than deploying a host that mails from a
  // domain the adopter's DKIM does not cover. Installed-and-broken is not that state, and refuses,
  // through the same classifier as the enqueue seam: deploying a host that silently never mails is the
  // other half of the same mistake.
  const emailModule = await loadOptionalEmail(() => import("@pithy-sh/email/src/capability"));
  const composed = emailModule && capabilities.find(emailModule.isEmailCapability);
  const email: TestersEmailIdentity | undefined = composed
    ? {
        fromAddress: composed.emailConfig.fromAddress,
        fromName: composed.emailConfig.fromName,
        theme: composed.emailConfig.theme,
        // The same journey the theme makes, and for the same reason: the daily-pass host composes
        // nothing, so the project's catalogs can only reach it as a var a provision run writes. Without
        // it the host reads `env.EMAIL_MESSAGES` and finds a var nobody wrote — the defect this
        // capability's own `enqueueSeam.ts` documents, surviving on the second Worker that reads it.
        messages: composed.hostCatalogs(),
      }
    : undefined;

  const cf = new CloudflareClients({ accountId, apiToken });
  return {
    email,
    project,
    environments,
    provisioner: new CloudflareTestersProvisioner({
      cf,
      project,
      account,
      apiToken,
      testersConfig: testers.testersConfig,
      email,
      resolveEnv: buildResolveEnv(projectDir, project, cf, account),
      audit: await buildAudit(projectDir, accountId, apiToken),
    }),
  };
}

/** The audit emitter for a testers command. A no-op without credentials or the audit capability. */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  // Provisioning spans every managed environment at once, so there is no single target env to key the
  // audit database on — `dev` is the fallback, matching `pithy storage`, `pithy media` and `pithy payments`.
  return createCliAudit({
    projectDir,
    // `env` selects the audit database only. This command spans environments, so no single
    // value is true for the run; each event states the environment it acted on.
    env: "dev",
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** A wrangler env stanza — only the fields the host deploy reads from the project's own config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, WranglerStanza | undefined>;
}

/** Resolve the per-environment database ids the host binds, from the project's `wrangler.jsonc`. */
function buildResolveEnv(projectDir: string, project: string, cf: CloudflareClients, account: ConfirmedAccount) {
  return async (env: ManagedEnvironment) => {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to wrangler.jsonc with its DB binding.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((database) => database.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding — the roster lives there.`,
      });
    }

    // One suppression database per project, shared across that project's environments, matching how
    // `@pithy-sh/email` provisions it: an unsubscribe in production has to stop staging too. So it is
    // looked up by name rather than read from the env stanza.
    const suppressionName = suppressionDatabaseName(project);
    const suppression = await findOnConfirmedAccount({
      ...account,
      what: `the ${suppressionName} database`,
      find: () => cf.d1Provisioner().findDatabaseByName(suppressionName),
    });
    if (!suppression) {
      throw new ValidationError({
        message: `This project's email-suppression database (${suppressionName}) does not exist.`,
        action: "Run `pithy email provision` first — the daily pass reads it to reconcile bounced addresses.",
      });
    }
    return { appDatabaseId, suppressionDatabaseId: suppression.uuid };
  };
}

const provision = defineCommand({
  meta: { name: "provision", description: "Deploy the daily-pass Workflow worker and write its binding" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    env: {
      type: "string",
      description: `Provision one environment only, from the set pithy.config.ts declares (default ${DEFAULT_ENVIRONMENTS.join(", ")}). Omit for every one.`,
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { provisioner, project, email, environments: declared } = await buildProvisioner(projectDir);
      const { testersWorkflowRegistry, TESTERS_CAPABILITY, provisionTesters } = await loadTestersProvisioning();

      // Parsed, not cast. `--env dev` is a real thing to type, and dev is local-only — the cast turned a
      // one-line answer into a raw Cloudflare error from a worker that was never deployed.
      const environments: ManagedEnvironment[] = args.env
        ? [requireManagedEnvironment(args.env, declared)]
        : managedEnvironments(declared);

      const results = await provisionTesters(provisioner, project, environments);

      for (const { env } of results) {
        // Only now can the Workflow binding be written. `pithy add testers` cannot: wrangler requires a
        // `name` and a `class_name` on every `workflows` entry, and the deployed name is per environment
        // (`<project>-<env>-testers-daily`). An entry short of either field fails the whole config, so `add`
        // emits none and this completes it — see capabilities/add.ts.
        await applyAppBindings(projectDir, env, {
          workflows: appWorkflowBindings(testersWorkflowRegistry, { project, capability: TESTERS_CAPABILITY, env }),
        });
      }

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "testers provision", results, sends: email !== undefined })}\n`,
        );
        return;
      }
      for (const { env, worker } of results) {
        process.stdout.write(`${env}: ${worker} deployed, TESTERS_DAILY bound.\n`);
      }
      process.stdout.write(dim("The pass runs daily at 05:00 UTC. `pithy testers run` runs one now.\n"));
      if (!email) {
        // Said here rather than discovered on the first silent morning.
        process.stdout.write(
          dim("No email capability is composed, so the pass will record the day but send nothing.\n"),
        );
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Delete the daily-pass worker. The roster and its history stay." },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    env: {
      type: "string",
      description: `Deprovision one environment only, from the set pithy.config.ts declares (default ${DEFAULT_ENVIRONMENTS.join(", ")}). Omit for every one.`,
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { provisioner, project, environments: declared } = await buildProvisioner(projectDir);
      const { deprovisionTesters } = await loadTestersProvisioning();

      const environments: ManagedEnvironment[] = args.env
        ? [requireManagedEnvironment(args.env, declared)]
        : managedEnvironments(declared);
      const results = await deprovisionTesters(provisioner, project, environments);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "testers deprovision", results })}\n`);
        return;
      }
      for (const { env, worker } of results) process.stdout.write(`${env}: ${worker} deleted.\n`);
      // Deliberately non-destructive to data. The cohorts, the roster, and the whole snapshot series are
      // rows in the adopter's own D1 and are not this command's to remove.
      process.stdout.write(dim("Your cohorts, roster, and trend history are untouched.\n"));
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const create = defineCommand({
  meta: { name: "create", description: "Create a testing cohort" },
  args: {
    name: { type: "positional", description: "A label for the cohort, e.g. closed-test" },
    env: ENV_ARG,
    "target-size": { type: "string", description: "Testers required simultaneously (default: 12, Play's floor)" },
    "window-days": { type: "string", description: "Continuous days required (default: 14, Play's window)" },
    "max-roster": { type: "string", description: "Roster cap (default: 100)" },
    platform: { type: "string", description: "android or ios (default: android)" },
    "store-url": {
      type: "string",
      description: "The store's own opt-in link, e.g. https://play.google.com/apps/testing/<package>",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, config, driver, modules } = await openTesters(args.env);
      try {
        const defaults = config.cohortDefaults;
        const cohort = await modules.createCohort(
          { db, now: new Date(), newId: () => crypto.randomUUID() },
          {
            name: boundedName(
              required(args.name, "a cohort name", "pithy testers create closed-test"),
              config.maxNameLength,
              "cohort name",
            ),
            targetSize: wholeNumber(args["target-size"], "--target-size", defaults.targetSize),
            windowDays: wholeNumber(args["window-days"], "--window-days", defaults.windowDays),
            maxRosterSize: wholeNumber(args["max-roster"], "--max-roster", defaults.maxRosterSize),
            targetPlatform: oneOf(args.platform, ["android", "ios"] as const, "--platform", defaults.targetPlatform),
            storeOptInUrl: args["store-url"] ?? defaults.storeOptInUrl,
            resetPolicy: defaults.resetPolicy,
          },
        );
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers create", cohort })}\n`);
          return;
        }
        process.stdout.write(`${cohort.name}: ${cohort.targetSize} testers for ${cohort.windowDays} days.\n`);
        // The number that actually matters, and the one nobody works out for themselves.
        process.stdout.write(
          dim(`Carry more than ${cohort.targetSize} — that is the number that must still be standing at the end.\n`),
        );
        // Said now rather than discovered later: without it the second email never goes out, and a
        // tester who agreed to help waits forever for a link nobody sent.
        if (!cohort.storeOptInUrl) {
          process.stdout.write(
            dim("No store link yet. Set one with --store-url before anyone can actually join the test.\n"),
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List cohorts and where each one stands" },
  args: {
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, d1, config, driver, modules } = await openTesters(args.env);
      try {
        const now = new Date();
        const cohorts = await modules.listCohorts(db);
        const rows = [];
        for (const cohort of cohorts) {
          const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json));
          rows.push({
            id: cohort.id,
            name: cohort.name,
            estimatedOptedIn: reading.clock.estimatedOptedInCount,
            targetSize: cohort.targetSize,
            estimatedHeldDays: reading.clock.estimatedHeldDays,
            windowDays: cohort.windowDays,
            closed: cohort.closedAt !== null,
          });
        }
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers list", cohorts: rows })}\n`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("Nothing here yet.\n");
          return;
        }
        process.stdout.write(
          `${formatList(
            rows.map((row) => ({
              name: row.name,
              description: `${row.estimatedOptedIn} of ${row.targetSize} opted in. Day ${row.estimatedHeldDays} of ${row.windowDays}.`,
            })),
          )}\n`,
        );
        process.stdout.write(`\n${dim(ESTIMATE_NOTE)}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const invite = defineCommand({
  meta: { name: "invite", description: "Add one or more addresses to a cohort's roster" },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    email: { type: "string", description: "Address to invite. Repeat the flag for several.", required: true },
    name: { type: "string", description: "A display name for the roster" },
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, config, driver, modules } = await openTesters(args.env);
      try {
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers status closed-test"),
        );
        const emails = (Array.isArray(args.email) ? args.email : [args.email]).map(String);
        const invited = [];
        for (const email of emails) {
          const result = await modules.inviteMember(
            { db, now: new Date(), newId: () => crypto.randomUUID() },
            {
              cohortId: cohort.id,
              email,
              name: args.name ? boundedName(args.name, config.maxNameLength, "tester name") : null,
              maxRosterSize: cohort.maxRosterSize,
            },
          );
          invited.push({ id: result.member.id, email: result.member.email, created: result.created });
        }
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers invite", cohort: cohort.id, invited })}\n`);
          return;
        }
        process.stdout.write(`${invited.length} added to ${cohort.name}.\n`);
        process.stdout.write(dim("Run `pithy testers run` to ask them whether they will test.\n"));
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const pending = defineCommand({
  meta: {
    name: "pending",
    description: "Who has agreed to test and is waiting to be added to the store's tester list",
  },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, driver, modules } = await openTesters(args.env);
      try {
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers pending closed-test"),
        );
        // The one step Pithy cannot do for you: the Play Developer API has no way to add an address to
        // an email list, so this prints the addresses and you paste them into the console. Until that is
        // done the store link answers `App not available`, which is why the second email waits.
        const waiting = (await modules.listMembers(db, cohort.id)).filter((member) => member.state === "accepted");
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "testers pending", cohort: cohort.id, emails: waiting.map((m) => m.email) })}\n`,
          );
          return;
        }
        if (waiting.length === 0) {
          process.stdout.write("Nobody waiting.\n");
          return;
        }
        for (const member of waiting) process.stdout.write(`${member.email}\n`);
        process.stdout.write(
          dim(`\nAdd these to the tester list in the console, then run \`pithy testers run\` to send them the link.\n`),
        );
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const roster = defineCommand({
  meta: { name: "roster", description: "The full roster, with per-tester activity and health" },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, d1, config, driver, modules } = await openTesters(args.env);
      try {
        const now = new Date();
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers status closed-test"),
        );
        const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json));
        const view = modules.toCohortView(
          reading,
          config,
          { includeMembers: true, snapshots: [], latest: undefined },
          now,
        );
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers roster", cohort: view })}\n`);
          return;
        }
        process.stdout.write(
          `${formatList(
            (view.members ?? []).map((member) => ({
              name: member.email,
              description: describeMember(member),
            })),
          )}\n`,
        );
        process.stdout.write(`\n${dim(ESTIMATE_NOTE)}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

/** One roster line: the estimate, then the fact, kept visibly apart. */
function describeMember(member: {
  state: string;
  health: number | null;
  activity: { state: string; daysDark: number | null };
}): string {
  const estimated = member.state.replace(/_/g, " ");
  if (member.activity.state === "never_linked") return `${estimated} · never signed in`;
  if (member.activity.state === "unreachable") return `${estimated} · address bounced`;
  const dark = member.activity.daysDark ?? 0;
  const observed = dark === 0 ? "active today" : `quiet ${dark}d`;
  return `${estimated} · ${observed} · health ${member.health ?? "—"}`;
}

const status = defineCommand({
  meta: { name: "status", description: "Where a cohort stands: the clock, activity, the forecast, the trend" },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    env: ENV_ARG,
    "trend-days": { type: "string", description: "How many daily snapshots to include (default: 30)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, d1, config, driver, modules } = await openTesters(args.env);
      try {
        const now = new Date();
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers status closed-test"),
        );
        const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json));
        const days = wholeNumber(args["trend-days"], "--trend-days", 30);
        const snapshots = await modules.listSnapshots(db, cohort.id, days);
        const view = modules.toCohortView(
          reading,
          config,
          { includeMembers: false, snapshots, latest: snapshots[snapshots.length - 1] },
          now,
        );

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers status", cohort: view })}\n`);
          return;
        }

        const clock = view.estimatedClock;
        const activity = view.activity;
        const projection = view.projection;
        const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

        process.stdout.write(`Cohort:    ${view.name}\n`);
        process.stdout.write(
          `Estimated: ${view.roster.optedIn} of ${view.targetSize} opted in. Day ${clock.estimatedHeldDays} of ${view.windowDays}.\n`,
        );
        process.stdout.write(
          `Observed:  ${activity.active} active. ${activity.darkEightToThirteen + activity.darkFourteenPlus} quiet 8+ days. ${activity.neverLinked} never signed in.\n`,
        );
        const range = projection.successProbabilityRange;
        process.stdout.write(
          `Forecast:  ${percent(projection.successProbability)}${
            range ? ` (${percent(range.low)}–${percent(range.high)})` : ""
          }. ${projection.confidence ?? "no"} confidence.\n`,
        );
        process.stdout.write(`Trend:     ${capitalize(view.trend.direction)}. ${view.trend.reason}\n`);
        if (projection.invitesNeeded > 0) {
          process.stdout.write(`\nInvite ${projection.invitesNeeded} more.\n`);
        }
        if (view.trend.fragile) {
          process.stdout.write(`\n${saffron("One lapse from a reset.")}\n`);
        }
        // Printed on every invocation, not behind a flag. A developer reading "day 13 of 14" is about
        // to make a decision on it.
        process.stdout.write(`\n${dim(ESTIMATE_NOTE)}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Take a tester off a cohort's roster" },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    email: { type: "string", description: "The tester's address", required: true },
    reason: { type: "string", description: "A short note recorded on the event" },
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, driver, modules } = await openTesters(args.env);
      try {
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers status closed-test"),
        );
        const member = await modules.findMemberByEmail(db, cohort.id, String(args.email));
        if (!member) {
          throw new ValidationError({
            message: "That address is not on this cohort.",
            action: `Run \`pithy testers roster ${cohort.name}\` to see who is.`,
          });
        }
        const removed = await modules.removeMember(
          { db, now: new Date(), newId: () => crypto.randomUUID() },
          member.id,
          args.reason,
        );
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "testers remove", member: { id: removed.id, email: removed.email } })}\n`,
          );
          return;
        }
        process.stdout.write(`${removed.email} removed from ${cohort.name}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const close = defineCommand({
  meta: { name: "close", description: "Close a cohort: keep its history, stop accruing snapshots and nudges" },
  args: {
    cohort: { type: "positional", description: "The cohort name or id" },
    env: ENV_ARG,
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, driver, modules } = await openTesters(args.env);
      try {
        const cohort = await modules.resolveCohortRef(
          db,
          required(args.cohort, "a cohort", "pithy testers close closed-test"),
        );
        const closed = await modules.closeCohort({ db, now: new Date(), newId: () => crypto.randomUUID() }, cohort.id);
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers close", cohort: closed })}\n`);
          return;
        }
        process.stdout.write(`${closed.name} closed.\n`);
        // The history stays queryable — a finished cohort is evidence, and the trend chart is the thing
        // a developer shows when the store asks what testing they did.
        process.stdout.write(dim("Its roster and trend stay readable. Nothing further is sent.\n"));
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

const run = defineCommand({
  meta: { name: "run", description: "Run the daily pass now: advance state, chase, and record the day" },
  args: {
    cohort: { type: "string", description: "Run one cohort only. Omit for every open cohort." },
    env: ENV_ARG,
    "skip-nudges": {
      type: "boolean",
      default: false,
      description: "Advance state and record the day, but send nothing",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { db, d1, config, driver, modules, enqueue } = await openTesters(args.env);
      try {
        // Real sends. The CLI needs no sending domain of its own: `enqueueEmail` writes a row into
        // `pithy_email_jobs`, and the email worker that already exists for any project using auth
        // delivers it. And nothing has to be minted, because the confirmation token lives on the member
        // row — which is the whole reason it stopped being a signature.
        const deps = {
          db,
          d1,
          config,
          now: new Date(),
          newId: () => crypto.randomUUID(),
          // The pass reports what it could not do — an unreadable suppression list, a roster it cannot
          // see activity for. Same logger the read commands use, for the same reason.
          log: readerLog(args.json),
          enqueue: args["skip-nudges"] ? undefined : enqueue,
          // The CLI resolves one database, the app `DB`. Without the suppression binding the pass leaves
          // deliverability flags alone rather than inferring a bounce from a table it cannot read.
          suppressionD1: undefined,
          optOutLinkFor: (member: { optInToken: string }) => modules.optOutUrl(config, member.optInToken),
          linkFor: args["skip-nudges"]
            ? undefined
            : (kind: "confirm" | "store" | "inactive" | "closing", member: { optInToken: string }) =>
                kind === "confirm"
                  ? modules.confirmUrl(config, member.optInToken)
                  : kind === "store"
                    ? modules.optInUrl(config, member.optInToken)
                    : undefined,
        };
        // Resolved rather than passed through raw: every sibling command takes a name or an id, and a
        // name reaching `runCohortPass` as an id would 404 on a cohort the developer can see listed.
        const results = args.cohort
          ? [await modules.runCohortPass(deps, (await modules.resolveCohortRef(db, args.cohort)).id)]
          : await modules.runDailyPass(deps);

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "testers run", results })}\n`);
          return;
        }
        for (const result of results) {
          process.stdout.write(
            `${result.cohortId}: ${result.estimatedOptedInCount} opted in, day ${result.estimatedHeldDays}. ${capitalize(result.trendDirection)}.\n`,
          );
        }
        // The truth, not a stale note. This line claimed nothing was sent long after the pass began
        // sending for real — the kind of copy that teaches a developer to stop reading the output.
        const queued = results.reduce(
          (total, result) => total + Object.values(result.nudged).reduce((sum, count) => sum + count, 0),
          0,
        );
        if (args["skip-nudges"] || !enqueue) {
          process.stdout.write(
            dim(
              enqueue
                ? "Nothing was sent.\n"
                : "Nothing was sent — no email capability is configured in this project.\n",
            ),
          );
        } else {
          process.stdout.write(
            dim(`${queued} email${queued === 1 ? "" : "s"} queued. Delivery is the email worker's job.\n`),
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      } finally {
        await driver.dispose();
      }
    }),
});

/** Sentence case for an enum value. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default defineCommand({
  meta: { name: "testers", description: "Run a closed test: cohorts, roster, the clock, and the daily pass" },
  subCommands: { provision, deprovision, create, list, invite, pending, roster, status, remove, close, run },
});
