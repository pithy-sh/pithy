// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { revokeToken } from "@pithy-sh/cloudflare/src/oauth/client";
import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { PithyError, PreconditionFailedError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import { bindProfile, boundProfileSync, setDefaultProfile, unbindApplying } from "../cloudflare/session/bindings";
import { chooseSessionAccount, type SessionAccount, type SignInIo, signIn } from "../cloudflare/session/connect";
import { replaceSession } from "../cloudflare/session/refresh";
import { deleteSession, readSessionSync } from "../cloudflare/session/store";
import { withContract } from "../contract/commandContract";
import { NO_OPEN_ENV, openUrl } from "../platform/browser";
import { loadProject, loadProjectCloudflare } from "../project/config";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * **`pithy cloudflare` — sign in to Cloudflare in a browser, and say which directory uses which session
 * (#759).**
 *
 * Named for the party it connects to, with `connect`/`disconnect` as the verbs, because that is the kit's
 * word for a stored, credentialed relationship: `pithy dashboard connect` already exists, and
 * `docs/AGENT-ACCESS.md` calls the agent-to-backend object a *connection*. `pithy login` is the gate's own
 * example of a command the CLI does not have, and `pithy auth` would read as the `auth` capability.
 */

const jsonArg = { json: { type: "boolean", default: false, description: "Machine-readable output" } } as const;

const profileArg = {
  profile: {
    type: "string",
    description:
      "The profile to sign in, sign out or bind. Defaults to the one bound here, then the project's account name, then default",
  },
} as const;

/** The profile a command acts on when none is named: the one bound here, the project's account nickname, `default`. */
async function defaultProfile(cwd: string): Promise<string> {
  const bound = boundProfileSync(cwd);
  if (bound !== null) return bound.profile;
  try {
    const accountName = loadProjectCloudflare(await loadProject(cwd))?.accountName;
    if (accountName !== undefined) return accountName;
  } catch {
    // No project here: `connect` before `init` is an ordinary order.
  }
  return "default";
}

/** The project's pinned account id, when there is a project and it pins one. */
async function pinnedAccount(cwd: string): Promise<string | undefined> {
  try {
    return loadProjectCloudflare(await loadProject(cwd))?.accountId;
  } catch {
    return undefined;
  }
}

/** Whether `PITHY_NO_OPEN` says not to open a browser. Any non-blank value. */
function noOpenFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[NO_OPEN_ENV] ?? "").trim().length > 0;
}

/** The prompt library, as the two questions here use it. Loaded only when a run may ask. */
type Clack = typeof import("@clack/prompts");

/**
 * Ask for the address the browser landed on. Optional: the loopback callback answers the same question,
 * and the race drops this prompt the moment it does. `null` is a cancel.
 */
async function askLandingAddress(clack: Clack, signal: AbortSignal): Promise<string | null> {
  const answer = await clack.text({ message: "Paste the address the browser landed on:", signal });
  return clack.isCancel(answer) ? null : String(answer);
}

/** Ask which account this directory uses, when the session sees several. `--account` answers it. */
async function askSessionAccount(clack: Clack, choices: readonly SessionAccount[]): Promise<string | null> {
  const picked = await clack.select({
    message: "Which Cloudflare account does this directory use?",
    options: choices.map((choice) => ({ value: choice.id, label: choice.name, hint: choice.id })),
  });
  return clack.isCancel(picked) ? null : String(picked);
}

const ConnectPayload = z
  .object({
    command: z.literal("cloudflare connect").describe('`"cloudflare connect"`.'),
    profile: z.string().describe("The profile signed in."),
    email: z.string().nullable().describe("Who signed in, from `GET /user`. The actor every audit row now names."),
    account: z
      .object({
        id: z.string().describe("The account id the session acts on, discovered at sign-in."),
        name: z.string().describe("The account's name as Cloudflare lists it."),
      })
      .describe("The account the session acts on."),
    boundTo: z
      .string()
      .describe("The directory the profile is now bound to. A repository is keyed by its main checkout."),
    scopes: z.array(z.string()).describe("The scopes granted, derived from what this project's tokens carry."),
    expiresAt: z.string().describe("When the access token expires, ISO-8601. It renews without a browser."),
  })
  .describe("A signed-in Cloudflare session, bound to this directory.");

const connect = withContract(
  defineCommand({
    meta: { name: "connect", description: "Sign in to Cloudflare in a browser and bind the session to this directory" },
    args: {
      ...profileArg,
      account: { type: "string", description: "The account id to use, when the sign-in can see several" },
      open: { type: "boolean", default: true, description: "Open the sign-in in a browser. --no-open prints it only" },
      ...jsonArg,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const cwd = process.cwd();
        const profile = args.profile ?? (await defaultProfile(cwd));
        // Loaded here, not at the top: deriving the scopes reads the project's token profiles, which reach the
        // Cloudflare SDK, and `pithy cloudflare --help` must not pay for that (#482).
        const { projectSessionScopes } = await import("../cloudflare/session/projectScopes");
        const { scopes } = await projectSessionScopes(cwd);
        const write = (line: string) => (args.json ? process.stderr : process.stdout).write(`${line}\n`);
        const interactive = mayPrompt(args.json);
        const clack = interactive ? await import("@clack/prompts") : undefined;
        const io: SignInIo = {
          write,
          open: (url) => openUrl(url),
          ask: clack === undefined ? undefined : (signal) => askLandingAddress(clack, signal),
        };

        const grant = await signIn({ scopes, open: args.open && !noOpenFromEnv() }, io);

        const { listCloudflareAccounts } = await import("@pithy-sh/cloudflare/src/client/accounts");
        const accounts = await listCloudflareAccounts({ apiToken: grant.accessToken });
        const account: SessionAccount = await chooseSessionAccount(accounts, {
          pinned: await pinnedAccount(cwd),
          requested: args.account,
          choose: clack === undefined ? undefined : (choices) => askSessionAccount(clack, choices),
        });
        const { CloudflareUserManager } = await import("@pithy-sh/cloudflare/src/user/userManager");
        const user = await new CloudflareUserManager({ apiToken: grant.accessToken, accountId: account.id }).getUser();

        // A sign-in does not quietly move a profile to another account. With no --profile named, the profile
        // is one this directory or its project chose, and replacing its session with another account's
        // would move every directory bound to it with it.
        const existing = readSessionSync(profile);
        if (existing !== null && existing.accountId !== account.id && args.profile === undefined) {
          throw new PreconditionFailedError({
            message: `Profile ${profile} already holds a session for account ${existing.accountName ?? existing.accountId}, and this sign-in is for ${account.name}.`,
            action: `Pass --profile with a new name for this account, or with ${profile} to replace that session and move every directory bound to it.`,
            detail: `existing ${existing.accountId}; signed in to ${account.id}`,
          });
        }
        await replaceSession({
          profile,
          accountId: account.id,
          accountName: account.name,
          email: user.email ?? null,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          expiresAt: grant.expiresAt.toISOString(),
          scope: grant.scope,
        });
        const boundTo = await bindProfile(cwd, profile);

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "cloudflare connect",
              profile,
              email: user.email ?? null,
              account,
              boundTo,
              scopes: grant.scope.split(/\s+/).filter(Boolean),
              expiresAt: grant.expiresAt.toISOString(),
            })}\n`,
          );
          return;
        }
        process.stdout.write(
          `Signed in to Cloudflare${user.email ? ` as ${user.email}` : ""}, on account ${account.name} (${account.id}).\n`,
        );
        process.stdout.write(`Profile ${profile} is bound to ${boundTo}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: ConnectPayload,
    mutates: true,
    // Each run is a new sign-in and a new session.
    idempotent: false,
    needsNetwork: true,
  },
);

const DisconnectPayload = z
  .object({
    command: z.literal("cloudflare disconnect").describe('`"cloudflare disconnect"`.'),
    profile: z.string().describe("The profile signed out."),
    revoked: z.boolean().describe("Whether Cloudflare revoked the session. `false` when there was none to revoke."),
    sessionDeleted: z.boolean().describe("Whether a session file was deleted from this machine."),
    unbound: z.boolean().describe("Whether this directory's binding was removed, with --unbind."),
  })
  .describe("What `pithy cloudflare disconnect` revoked and deleted.");

const disconnect = withContract(
  defineCommand({
    meta: { name: "disconnect", description: "Revoke a profile's Cloudflare session and delete it from this machine" },
    args: {
      ...profileArg,
      unbind: {
        type: "boolean",
        default: false,
        description: "Also remove this directory's binding, so credentials resolve as if no profile were bound",
      },
      ...jsonArg,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const profile = args.profile ?? (await defaultProfile(process.cwd()));
        const session = readSessionSync(profile);
        // Revoke first, then delete — and delete whatever the revocation said, because a file nobody can
        // use is worse kept than lost. A refusal is reported after the delete, so the operator knows the
        // grant may still be live at Cloudflare.
        let failure: PithyError | null = null;
        if (session !== null) {
          for (const [token, hint] of [
            [session.refreshToken, "refresh_token"],
            [session.accessToken, "access_token"],
          ] as const) {
            if (token === null) continue;
            await revokeToken({ token, hint }).catch((error: unknown) => {
              failure ??= error instanceof PithyError ? error : new UpstreamError({ message: String(error) });
            });
          }
        }
        const sessionDeleted = await deleteSession(profile);
        // The binding stays unless asked: a directory bound to a signed-out profile refuses rather than
        // falling back to an exported token, which is the point of binding it. `--unbind` is the way back.
        const unbound = args.unbind ? (await unbindApplying(process.cwd())) !== null : false;
        if (failure !== null) {
          const refused = failure as PithyError;
          throw new UpstreamError({
            message: `Deleted profile ${profile}'s session from this machine. ${refused.payload.message}`,
            action: refused.payload.action,
            detail: refused.payload.detail,
          });
        }
        const revoked = session !== null;
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "cloudflare disconnect", profile, revoked, sessionDeleted, unbound })}\n`,
          );
          return;
        }
        process.stdout.write(
          revoked
            ? `Revoked profile ${profile}'s Cloudflare session and deleted it.\n`
            : `Profile ${profile} has no session on this machine.\n`,
        );
        if (unbound) process.stdout.write("This directory is no longer bound to a profile.\n");
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: DisconnectPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

const UsePayload = z
  .object({
    command: z.literal("cloudflare use").describe('`"cloudflare use"`.'),
    profile: z.string().describe("The profile bound."),
    boundTo: z
      .string()
      .nullable()
      .describe("The directory bound, keyed by its repository's main checkout. `null` when it was set as the default."),
    signedIn: z.boolean().describe("Whether the profile has a session on this machine yet."),
  })
  .describe("Which profile `pithy cloudflare use` bound, and where.");

const use = withContract(
  defineCommand({
    meta: { name: "use", description: "Bind a Cloudflare profile to a directory, or make it the default" },
    args: {
      profile: { type: "positional", required: true, description: "The profile to bind" },
      dir: { type: "positional", required: false, description: "The directory to bind. Defaults to this one" },
      default: { type: "boolean", default: false, description: "Make it the profile used where nothing is bound" },
      ...jsonArg,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        let boundTo: string | null = null;
        if (args.default) await setDefaultProfile(args.profile);
        else boundTo = await bindProfile(args.dir ?? process.cwd(), args.profile);
        const signedIn = readSessionSync(args.profile) !== null;
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "cloudflare use", profile: args.profile, boundTo, signedIn })}\n`,
          );
          return;
        }
        process.stdout.write(
          boundTo === null
            ? `Profile ${args.profile} is the default.\n`
            : `Profile ${args.profile} is bound to ${boundTo}.\n`,
        );
        if (!signedIn) {
          process.stdout.write(
            `It has no session yet. Run ${pithyCommand("cloudflare connect", { flags: { "--profile": args.profile } })} to sign in.\n`,
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: UsePayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);

export default defineCommand({
  meta: {
    name: "cloudflare",
    description: "Sign in to Cloudflare, and choose which session each directory uses",
  },
  subCommands: { connect, disconnect, use },
});
