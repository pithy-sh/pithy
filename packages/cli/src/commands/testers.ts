// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  type Command,
  type CommandPath,
  callerOf,
  commandAlternatives,
  commandName,
  pithyCommand,
  rerunRemedy,
} from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import type { EmailMessageLayers } from "@pithy-sh/email/src/templates/messages";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { z } from "zod";
import { createProjectCliAudit } from "../audit/cliAudit";
import { hostEntrySource } from "../capabilities/hostEntry";
import { hostWorkerFor } from "../capabilities/hostRegistry";
import { classifyCapabilityLoadFailure } from "../capabilities/loadFailure";
import { capabilityNotComposed } from "../capabilities/notComposed";
import { loadTesters, testersAuth } from "../capabilities/testersLoader";
import { CloudflareTestersProvisioner, loadTestersProvisioning } from "../capabilities/testersProvisioner";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment, requireManagedEnvironment } from "../project/environment";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  narrowReadiness,
  ProvisionReportExitCode,
  readyStanza,
  requireReadyEnvironments,
  SkippedEnvironment,
  writeProvisionReport,
} from "../project/environmentReadiness";
import { kitImport } from "../project/kitResolve";
import { workerDirName } from "../project/workerIdentity";
import {
  composedProjectCapabilities,
  projectCapabilities,
  type ResolvedWorker,
  resolveSingleWorker,
  resolveWorkers,
} from "../project/workerScope";
import { suppressionDatabaseMissing } from "../provision/missingDatabase";
import { openSeedDriver } from "../seed/drivers";
import { createCliLogger } from "../terminal/logger";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim, saffron } from "../terminal/style";

/** The daily pass for one cohort, now, in the environment the run was about. */
function passFor(cohort: string, env: string): Command {
  return pithyCommand("testers run", { flags: { "--cohort": cohort, "--env": env } });
}

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
function required(value: string | undefined, name: string, path: CommandPath): string {
  if (value === undefined || value.trim() === "") {
    throw new ValidationError({
      message: `Missing ${name}.`,
      action: `Pass ${name} to ${commandName(path)}, first.`,
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

/** The refusal for a project that composes no testers, with the `pithy add` that composes it. */
function testersNotComposed(projectDir: string, workers: readonly { dir: string }[]) {
  return capabilityNotComposed(
    "testers",
    {
      message: "The testers capability is not configured.",
      action: (add) => `Add \`testers({ baseUrl: '...' })\` to pithy.config.ts (run ${add}).`,
    },
    { projectDir, workerDirs: workers.map((worker) => worker.dir) },
  );
}

/** Resolve the app D1 for an environment, plus the resolved testers config. */
async function openTesters(requested: string) {
  // The roster commands' one door, so the `--env` check lives here rather than nine times over.
  const env = requireEnvironment(requested);
  const projectDir = process.cwd();
  const workers = await resolveWorkers({ projectDir });
  const { isTestersCapability } = await loadTesters(projectDir);
  const capability = projectCapabilities(workers).find(isTestersCapability);
  if (!capability) throw await testersNotComposed(projectDir, workers);
  // Capabilities live per Worker; the roster is one project-wide thing, so the first Worker composing
  // testers supplies both the config and the database binding.
  const worker = workers.find((entry) => entry.capabilities?.some(isTestersCapability)) ?? workers[0];
  // No Worker at all is the same refusal as none composing testers, with the same `pithy add` (#711).
  if (!worker) throw await testersNotComposed(projectDir, workers);

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
  const modules = await loadTesters(projectDir);
  return {
    driver,
    d1: driver.d1("DB"),
    db: modules.testersDatabase(driver.d1("DB")),
    config: capability.testersConfig,
    // What the activity read sees through: the project's composed auth, exactly as the daily-pass host is
    // handed it. Every reader below takes it, and `readCohort` requires it (#645 review).
    auth: testersAuth(projectDir, projectCapabilities(workers)),
    modules,
    enqueue: await buildEnqueue(projectDir, workers, driver.d1("DB")),
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
 * per the same convention: the `bin` runs on Bun, and a cause is read by its fields, never its class.
 */
export async function loadOptionalEmail<T>(load: () => Promise<T> | T, projectDir?: string): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    const failure = classifyCapabilityLoadFailure("email", EMAIL_MODULE, error, projectDir);
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
export async function buildEnqueue(
  projectDir: string,
  workers: Awaited<ReturnType<typeof resolveWorkers>>,
  d1: D1Database,
) {
  const modules = await loadOptionalEmail(
    async () => ({
      ...(await kitImport<typeof import("@pithy-sh/email/src/capability")>(
        projectDir,
        "@pithy-sh/email/src/capability",
      )),
      ...(await kitImport<typeof import("@pithy-sh/email/src/send/enqueue")>(
        projectDir,
        "@pithy-sh/email/src/send/enqueue",
      )),
      ...(await kitImport<typeof import("@pithy-sh/email/src/data/tables")>(
        projectDir,
        "@pithy-sh/email/src/data/tables",
      )),
    }),
    projectDir,
  );
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
async function buildProvisioner(projectDir: string, worker?: string) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const config = await loadProject(projectDir);
  const project = requireProjectName(config);
  // The project's own environment set (#241), carried rather than assumed.
  const environments = loadProjectEnvironments(config);
  const selection = await projectCloudflareAccount(projectDir);
  // What vouches for the id (#378) rides with it: the host teardown reads a missing Worker as "already gone", and
  // an account nothing claims answers exactly that way about a host that is still running.
  const { account, accountId, apiToken } = commandCredentials(selection);

  const workers = await resolveWorkers({ projectDir });
  // Assembled, for the same reason the enqueue seam above is: the catalogs stamped into the deployed
  // host come off `hostCatalogs()`, which answers `{}` until every `compose` hook has run.
  const capabilities = composedProjectCapabilities(workers);
  const { isTestersCapability } = await loadTesters(projectDir);
  const testers = capabilities.find(isTestersCapability);
  if (!testers) throw await testersNotComposed(projectDir, workers);

  // Undefined when no email capability is composed. The pass then advances state and writes its
  // snapshot but sends nothing — a real state, and better than deploying a host that mails from a
  // domain the adopter's DKIM does not cover. Installed-and-broken is not that state, and refuses,
  // through the same classifier as the enqueue seam: deploying a host that silently never mails is the
  // other half of the same mistake.
  const emailModule = await loadOptionalEmail(
    () => kitImport<typeof import("@pithy-sh/email/src/capability")>(projectDir, "@pithy-sh/email/src/capability"),
    projectDir,
  );
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

  const cf = await cloudflareClients({ accountId, apiToken });
  // Which environments can be acted on, read once per run and memoized. A thunk rather than an eager read
  // because `deprovision` shares this builder and deletes a Worker whether or not the app Worker's
  // `wrangler.jsonc` still describes the environment — making it read one would be a new way to fail. The
  // Worker is resolved **inside** the thunk for the same reason: `resolveSingleWorker` genuinely can fail
  // (a project with several Workers and no `--worker`), and a teardown must not acquire that failure.
  //
  // The file is the **app Worker's**, under `apps/<name>/`, because there is no root Worker (CLAUDE.md
  // §CLI). This read `<root>/wrangler.jsonc`, which no scaffolded project has, so every run died on a
  // missing file before it reached the partition, the skip, the report or the exit code (#512).
  let readiness: Promise<{ appWorker: ResolvedWorker; readiness: EnvironmentReadiness }> | undefined;
  const appReadiness = () => {
    readiness ??= (async () => {
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(worker !== undefined ? { worker } : {}),
      });
      return {
        appWorker,
        readiness: await environmentReadiness({
          workerDir: appWorker.dir,
          label: `${appWorker.name}'s wrangler.jsonc`,
          environments,
          productionEnvironments: config.seed?.productionEnvironments,
        }),
      };
    })();
    return readiness;
  };
  return {
    email,
    project,
    environments,
    appReadiness,
    provisioner: new CloudflareTestersProvisioner({
      cf,
      projectDir,
      project,
      account,
      apiToken,
      testersConfig: testers.testersConfig,
      email,
      // Auth, handed to the daily-pass host when the project composes it — asked only when a deploy runs (#645).
      hostEntry: () => {
        const spec = hostWorkerFor("testers");
        const siblings = capabilities.filter((capability) => capability !== testers);
        return spec ? hostEntrySource(projectDir, spec, testers, siblings) : undefined;
      },
      resolveEnv: buildResolveEnv(appReadiness, project, cf, account),
      audit: await buildAudit(projectDir, accountId, apiToken),
    }),
  };
}

/** The audit emitter for a testers command. A no-op without credentials or the audit capability. */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken });
}

/**
 * Resolve the per-environment database ids the host binds.
 *
 * The app `DB` id comes out of {@link EnvironmentReadiness}, which read the project's `wrangler.jsonc` once
 * and partitioned the declared environments before anything was deployed — an environment with no app
 * database is skipped and reported rather than failing the run part way through (#512). The suppression
 * database is still a live refusal, because it is project-global and its absence means `pithy email
 * provision` has not run at all, which no per-environment skip could express.
 */
function buildResolveEnv(
  /** Memoized, so `deprovision` — which shares this builder and never resolves an environment — reads no file. */
  appReadiness: () => Promise<{ appWorker: ResolvedWorker; readiness: EnvironmentReadiness }>,
  project: string,
  cf: CloudflareClients,
  account: ConfirmedAccount,
) {
  return async (env: ManagedEnvironment) => {
    const { appWorker, readiness } = await appReadiness();
    const { appDatabaseId } = readyStanza(readiness, env);

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
      // The Worker this run resolved, so the `fix` runs in a project with several (#697).
      throw suppressionDatabaseMissing(
        suppressionName,
        "the daily pass reads it to reconcile bounced addresses.",
        appWorker.dir,
      );
    }
    return { appDatabaseId, suppressionDatabaseId: suppression.uuid };
  };
}

const Iso = (what: string) => z.string().describe(`${what}, ISO-8601.`);
const IsoOrNull = (what: string) => z.string().nullable().describe(`${what}, ISO-8601, or \`null\`.`);
const Int = (what: string) => z.number().int().describe(what);
const Platform = z.enum(["android", "ios"]).describe("Which store's program the cohort serves.");
const ResetPolicy = z
  .enum(["reset", "pause"])
  .describe("Pithy's assumption about what a dip below target does to the streak.");

/** A cohort row, as `create` and `close` write it. */
const CohortRow = z
  .object({
    id: z.string().describe("The cohort's UUID."),
    name: z.string().describe("The human label."),
    targetPlatform: Platform,
    targetSize: Int("Testers who must be opted in simultaneously. Frozen on the row."),
    windowDays: Int("Continuous days the target must hold. Frozen on the row."),
    maxRosterSize: Int("The most members the roster may hold."),
    storeOptInUrl: z.string().nullable().describe("The store's own opt-in page, or `null` until set."),
    resetPolicy: ResetPolicy,
    closedAt: IsoOrNull("When the cohort was closed"),
    createdAt: Iso("When the cohort was created"),
    updatedAt: Iso("When the row was last written"),
  })
  .describe("One cohort row.");

/**
 * One cohort view, as `roster` and `status` write it — the shape the control plane serves a dashboard, owned
 * by `@pithy-sh/testers` (`CohortView`). The CLI cannot import that schema at run time, because the package
 * is the project's rather than the CLI's, so the blocks a script reads are typed here and the rest are open.
 * `testersJson.test.ts` holds a view the package's own schema accepts to this one.
 */
const CohortViewJson = z
  .looseObject({
    id: z.string().describe("The cohort id."),
    name: z.string().describe("The cohort's human label."),
    targetPlatform: Platform,
    targetSize: Int("Testers required simultaneously."),
    windowDays: Int("Continuous days required."),
    maxRosterSize: Int("The roster cap."),
    resetPolicy: ResetPolicy,
    createdAt: Iso("When the cohort was created"),
    closedAt: IsoOrNull("When it was closed"),
    roster: z
      .object({
        size: Int("Members on the roster, in every state."),
        headroomToMax: Int("How many more may be added before the cap."),
        invited: Int("Invited, and have not yet answered."),
        accepted: Int("Agreed to test, waiting for the store link."),
        optedIn: Int("Pithy's estimate of currently opted-in testers."),
        lapsed: Int("Opted out or removed."),
        unreachable: Int("Bounced or suppressed."),
        neverLinked: Int("Confirmed but never signed in."),
      })
      .describe("Current roster composition."),
    estimatedClock: z
      .object({
        source: z.literal("pithy_estimate").describe("This block is replayed from Pithy's own invite records."),
        meetsTarget: z.boolean().describe("Whether the estimated opted-in count is at or above target now."),
        headroom: Int("Estimated count minus target. It can go negative."),
        estimatedHeldDays: Int("The estimated unbroken at-target run ending today."),
        estimatedDaysRemaining: Int("Days still to hold, on Pithy's estimate."),
        estimatedWindowStartOn: z.string().nullable().describe("The UTC day the current run began, or `null`."),
        resetCount: Int("How many times the run has broken."),
        dayBoundary: z.literal("UTC").describe("Pithy counts days in UTC."),
      })
      .describe("Pithy's estimated clock."),
    activity: z
      .object({
        source: z.literal("observed").describe("This block is fact from the auth tables."),
        active: Int("Authenticated inside the active window."),
        darkThreeToSeven: Int("Quiet 3–7 days."),
        darkEightToThirteen: Int("Quiet 8–13 days."),
        darkFourteenPlus: Int("Quiet 14 days or more."),
        neverLinked: Int("No activity data at all."),
        observedCoverage: z.number().describe("Share of opted-in testers with any activity signal."),
      })
      .describe("The observed half."),
    projection: z.looseObject({}).describe("Pithy's forecast. Its fields are on `docs/commands/testers.md`."),
    trend: z.looseObject({}).describe("Direction of travel, and the series behind it."),
    reconciliation: z.looseObject({}).describe("Store reconciliation status. Honestly empty rather than absent."),
    disclaimer: z.looseObject({}).describe("Required beside any opt-in figure."),
    members: z
      .array(z.looseObject({}).describe("One tester, with activity and health."))
      .optional()
      .describe("The full roster. Present under `roster` only."),
  })
  .describe("One cohort view.");

const Results = z
  .array(
    z
      .object({
        env: z.string().describe("The environment."),
        worker: z.string().describe("The daily-pass Worker's deployed name."),
      })
      .describe("One environment."),
  )
  .describe("One entry per environment.");

const TestersProvisionPayload = z
  .object({
    command: z.literal("testers provision").describe('`"testers provision"`.'),
    results: Results.describe("One entry per environment provisioned."),
    skippedEnvironments: z
      .array(SkippedEnvironment)
      .describe("One entry per declared environment nothing was provisioned for."),
    sends: z.boolean().describe("Whether an email capability is composed. `false` records the day and sends nothing."),
    exitCode: ProvisionReportExitCode,
  })
  .describe("What `pithy testers provision` provisioned.");

const TestersDeprovisionPayload = z
  .object({
    command: z.literal("testers deprovision").describe('`"testers deprovision"`.'),
    results: Results.describe("One entry per environment torn down."),
  })
  .describe("What `pithy testers deprovision` removed.");

const TestersCreatePayload = z
  .object({ command: z.literal("testers create").describe('`"testers create"`.'), cohort: CohortRow })
  .describe("The cohort `pithy testers create` made.");

const TestersClosePayload = z
  .object({ command: z.literal("testers close").describe('`"testers close"`.'), cohort: CohortRow })
  .describe("The cohort as `pithy testers close` left it.");

const TestersListPayload = z
  .object({
    command: z.literal("testers list").describe('`"testers list"`.'),
    cohorts: z
      .array(
        z
          .object({
            id: z.string().describe("The cohort id."),
            name: z.string().describe("The cohort's human label."),
            estimatedOptedIn: Int("Pithy's estimate of the currently opted-in count."),
            targetSize: Int("The target in force."),
            estimatedHeldDays: Int("The estimated unbroken at-target run ending today."),
            windowDays: Int("Continuous days the program requires."),
            closed: z.boolean().describe("Whether the cohort has been closed."),
          })
          .describe("One cohort."),
      )
      .describe("Every cohort, newest first."),
  })
  .describe("What `pithy testers list` found.");

const TestersInvitePayload = z
  .object({
    command: z.literal("testers invite").describe('`"testers invite"`.'),
    cohort: z.string().describe("The resolved cohort id."),
    invited: z
      .array(
        z
          .object({
            id: z.string().describe("The member id."),
            email: z.string().describe("The invited address, normalized."),
            created: z.boolean().describe("`false` when the row already existed and was revived."),
          })
          .describe("One invited address."),
      )
      .describe("One entry per `--email`, in the order given."),
  })
  .describe("Who `pithy testers invite` added.");

const TestersPendingPayload = z
  .object({
    command: z.literal("testers pending").describe('`"testers pending"`.'),
    cohort: z.string().describe("The resolved cohort id."),
    emails: z
      .array(z.string().describe("An address."))
      .describe("Every tester who has agreed to test and waits to be added to the store's list."),
  })
  .describe("Who is waiting on the store's tester list.");

const TestersRosterPayload = z
  .object({ command: z.literal("testers roster").describe('`"testers roster"`.'), cohort: CohortViewJson })
  .describe("The cohort view, with its members.");

const TestersStatusPayload = z
  .object({ command: z.literal("testers status").describe('`"testers status"`.'), cohort: CohortViewJson })
  .describe("The cohort view, with its trend.");

const TestersRemovePayload = z
  .object({
    command: z.literal("testers remove").describe('`"testers remove"`.'),
    member: z
      .object({ id: z.string().describe("Their member id."), email: z.string().describe("Their address.") })
      .describe("The removed tester."),
  })
  .describe("Who `pithy testers remove` took off the roster.");

const TestersRunPayload = z
  .object({
    command: z.literal("testers run").describe('`"testers run"`.'),
    results: z
      .array(
        z
          .object({
            cohortId: z.string().describe("The cohort this entry describes."),
            snapshotOn: z.string().describe("The UTC day the pass recorded, `YYYY-MM-DD`."),
            nudged: z
              .record(z.string().describe("A nudge kind."), z.number().int().describe("How many were enqueued."))
              .describe("Nudges enqueued by kind: `confirm`, `store`, `inactive`, `closing`."),
            estimatedOptedInCount: Int("Pithy's estimate of the opted-in count after the pass."),
            estimatedHeldDays: Int("The estimated unbroken at-target run ending on this day."),
            trendDirection: z.string().describe("`improving`, `steady`, `declining` or `unknown`."),
            pruned: Int("Snapshots pruned by the retention policy."),
            nudgesSkipped: z
              .literal("no_base_url")
              .optional()
              .describe("Why nothing was sent, when sending was on and no link could be built. Absent otherwise."),
          })
          .describe("One cohort's pass."),
      )
      .describe("One entry per cohort the pass ran for."),
  })
  .describe("What `pithy testers run` did.");

/** The roster commands read and write the project's D1, through Cloudflare outside `dev`. */
const ROSTER = { output: "document", schemaVersion: 1, needsNetwork: true } as const;

const provision = withContract(
  defineCommand({
    meta: { name: "provision", description: "Deploy the daily-pass Workflow worker and write its binding" },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
      env: {
        type: "string",
        description: `Provision one environment only, from the set pithy.config.ts declares (default ${DEFAULT_ENVIRONMENTS.join(", ")}). Omit for every one.`,
      },
      worker: {
        type: "string",
        description:
          "The app worker whose wrangler.jsonc carries the per-environment DB binding and receives the TESTERS_DAILY binding (default: the project's only worker)",
      },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const {
          provisioner,
          project,
          email,
          environments: declared,
          appReadiness,
        } = await buildProvisioner(projectDir, args.worker);
        const { testersWorkflowRegistry, TESTERS_CAPABILITY, provisionTesters } =
          await loadTestersProvisioning(projectDir);

        // Parsed, not cast. `--env dev` is a real thing to type, and dev is local-only — the cast turned a
        // one-line answer into a raw Cloudflare error from a worker that was never deployed.
        const selected: ManagedEnvironment[] = args.env
          ? [requireManagedEnvironment(args.env, declared)]
          : managedEnvironments(declared);
        // Two narrowings, and they answer different questions. `--env` is which environments the operator
        // meant; readiness is which of those have an app database yet. Skip-and-report layers onto the flag
        // rather than replacing it (#512).
        const { appWorker, readiness: declaredReadiness } = await appReadiness();
        const readiness = narrowReadiness(declaredReadiness, selected);

        const results = await provisionTesters(provisioner, project, readiness.ready);

        for (const { env } of results) {
          // Only now can the Workflow binding be written. `pithy add testers` cannot: wrangler requires a
          // `name` and a `class_name` on every `workflows` entry, and the deployed name is per environment
          // (`<project>-<env>-testers-daily`). An entry short of either field fails the whole config, so `add`
          // emits none and this completes it — see capabilities/add.ts.
          // Into the **app Worker's** `wrangler.jsonc`, the same file readiness was read from. A project
          // root holds no wrangler config at all, so writing there wrote nothing an adopter ever loads.
          await applyAppBindings(appWorker.dir, env, {
            workflows: appWorkflowBindings(testersWorkflowRegistry, { project, capability: TESTERS_CAPABILITY, env }),
          });
        }

        const deployed = new Map(results.map((entry) => [entry.env, entry.worker]));

        // The caller's own run, as the refusal names it to run again: every flag it was given, the environment it
        // was narrowed to among them, and the Worker it resolved when none was named (#711).
        const rerun = rerunRemedy(callerOf("testers provision", args), {
          flags: { "--worker": workerDirName(appWorker) },
          productionEnvironments: readiness.productionEnvironments,
        });

        if (args.json) {
          // One outcome (#711): the error line alone when nothing was provisioned, or this report alone.
          writeProvisionReport(
            {
              command: "testers provision",
              results,
              skippedEnvironments: readiness.skipped,
              sends: email !== undefined,
            },
            readiness,
            rerun,
          );
          return;
        }
        process.stdout.write(
          formatEnvironmentOutcomes(
            environmentOutcomes(readiness, (env) => `${deployed.get(env)} deployed, TESTERS_DAILY bound`),
          ),
        );
        requireReadyEnvironments(readiness, rerun);
        const runNow = readiness.ready.map((env) => pithyCommand("testers run", { flags: { "--env": env } }));
        process.stdout.write(dim(`The pass runs daily at 05:00 UTC. ${commandAlternatives(runNow)} runs one now.\n`));
        if (!email) {
          // Said here rather than discovered on the first silent morning.
          process.stdout.write(
            dim("No email capability is composed, so the pass will record the day but send nothing.\n"),
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  { ...ROSTER, payload: TestersProvisionPayload, mutates: true, idempotent: true },
);

const deprovision = withContract(
  defineCommand({
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
        const { deprovisionTesters } = await loadTestersProvisioning(projectDir);

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
  }),
  { ...ROSTER, payload: TestersDeprovisionPayload, mutates: true, idempotent: true },
);

/**
 * The platforms `--platform` takes: one list, parsed against and published. The testers package's own enum
 * cannot be imported from a shipped module, so `testersJson.test.ts` holds this to it.
 */
const TARGET_PLATFORMS = ["android", "ios"] as const;

const create = withContract(
  defineCommand({
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
                required(args.name, "a cohort name", "testers create"),
                config.maxNameLength,
                "cohort name",
              ),
              targetSize: wholeNumber(args["target-size"], "--target-size", defaults.targetSize),
              windowDays: wholeNumber(args["window-days"], "--window-days", defaults.windowDays),
              maxRosterSize: wholeNumber(args["max-roster"], "--max-roster", defaults.maxRosterSize),
              targetPlatform: oneOf(args.platform, TARGET_PLATFORMS, "--platform", defaults.targetPlatform),
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
  }),
  {
    ...ROSTER,
    payload: TestersCreatePayload,
    mutates: true,
    idempotent: false,
    flags: { platform: { enum: TARGET_PLATFORMS } },
  },
);

const list = withContract(
  defineCommand({
    meta: { name: "list", description: "List cohorts and where each one stands" },
    args: {
      env: ENV_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { db, d1, config, driver, modules, auth } = await openTesters(args.env);
        try {
          const now = new Date();
          const cohorts = await modules.listCohorts(db);
          const rows = [];
          for (const cohort of cohorts) {
            const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json), auth);
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
  }),
  { ...ROSTER, payload: TestersListPayload, mutates: false, idempotent: true },
);

const invite = withContract(
  defineCommand({
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
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers status"));
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
          process.stdout.write(dim(`Run \`${passFor(cohort.name, args.env)}\` to ask them whether they will test.\n`));
          process.stdout.write(`${formatDone()}\n`);
        } finally {
          await driver.dispose();
        }
      }),
  }),
  {
    ...ROSTER,
    payload: TestersInvitePayload,
    mutates: true,
    // An address already live on the roster is refused (`testers/already_on_roster`), so a second identical
    // invite exits 3. Reviving a removed member is a first run, not a re-run.
    idempotent: false,
    flags: { email: { repeatable: true } },
  },
);

const pending = withContract(
  defineCommand({
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
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers pending"));
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
            dim(
              `\nAdd these to the tester list in the console, then run \`${passFor(cohort.name, args.env)}\` to send them the link.\n`,
            ),
          );
          process.stdout.write(`${formatDone()}\n`);
        } finally {
          await driver.dispose();
        }
      }),
  }),
  { ...ROSTER, payload: TestersPendingPayload, mutates: false, idempotent: true },
);

const roster = withContract(
  defineCommand({
    meta: { name: "roster", description: "The full roster, with per-tester activity and health" },
    args: {
      cohort: { type: "positional", description: "The cohort name or id" },
      env: ENV_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { db, d1, config, driver, modules, auth } = await openTesters(args.env);
        try {
          const now = new Date();
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers status"));
          const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json), auth);
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
  }),
  { ...ROSTER, payload: TestersRosterPayload, mutates: false, idempotent: true },
);

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

const status = withContract(
  defineCommand({
    meta: { name: "status", description: "Where a cohort stands: the clock, activity, the forecast, the trend" },
    args: {
      cohort: { type: "positional", description: "The cohort name or id" },
      env: ENV_ARG,
      "trend-days": { type: "string", description: "How many daily snapshots to include (default: 30)" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { db, d1, config, driver, modules, auth } = await openTesters(args.env);
        try {
          const now = new Date();
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers status"));
          const reading = await modules.readCohort(db, d1, cohort, config, now, readerLog(args.json), auth);
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
  }),
  { ...ROSTER, payload: TestersStatusPayload, mutates: false, idempotent: true },
);

const remove = withContract(
  defineCommand({
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
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers status"));
          const member = await modules.findMemberByEmail(db, cohort.id, String(args.email));
          if (!member) {
            throw new ValidationError({
              message: "That address is not on this cohort.",
              action: `Run \`${pithyCommand("testers roster", { args: [cohort.name], flags: { "--env": args.env } })}\` to see who is.`,
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
  }),
  { ...ROSTER, payload: TestersRemovePayload, mutates: true, idempotent: false },
);

const close = withContract(
  defineCommand({
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
          const cohort = await modules.resolveCohortRef(db, required(args.cohort, "a cohort", "testers close"));
          const closed = await modules.closeCohort(
            { db, now: new Date(), newId: () => crypto.randomUUID() },
            cohort.id,
          );
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
  }),
  { ...ROSTER, payload: TestersClosePayload, mutates: true, idempotent: false },
);

const run = withContract(
  defineCommand({
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
        const { db, d1, config, driver, modules, enqueue, auth } = await openTesters(args.env);
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
            // The snapshot this pass writes counts who was observed, so it is built on the project's auth or it
            // is a day of nobody observed. Required by the pass for that reason (#645 review).
            auth,
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
  }),
  {
    ...ROSTER,
    payload: TestersRunPayload,
    // Advances state and records the day; a second run the same day re-records it and nudges nobody new.
    mutates: true,
    idempotent: false,
  },
);

/** Sentence case for an enum value. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default defineCommand({
  meta: { name: "testers", description: "Run a closed test: cohorts, roster, the clock, and the daily pass" },
  subCommands: { provision, deprovision, create, list, invite, pending, roster, status, remove, close, run },
});
