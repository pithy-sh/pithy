// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { capabilityNotComposed } from "../capabilities/notComposed";
import { allCapabilities, type WorkerConfig } from "../project/config";
import { workerDirName } from "../project/workerIdentity";

/**
 * Which capability-gated screen sets a front end gets, decided the same way for every stub: a flag decides
 * outright, a human is asked, and anyone else gets whether the backend Worker composes that capability.
 */

/** The capability the auth template's screens are written against. */
const AUTH_CAPABILITY = "auth";

/** The capability the paywall and subscription screens are written against. */
const PAYMENTS_CAPABILITY = "payments";

/** The capability the account chooser is written against. */
const ORGANIZATION_CAPABILITY = "organization";
const CONSENT_CAPABILITY = "consent";
/** The capability whose agent consent and connected-applications screens ride on the auth screens. */
const MCP_CAPABILITY = "mcp";

/** Which capability-gated screen set a decision is about. */
export type UiScreenSet =
  | typeof AUTH_CAPABILITY
  | typeof PAYMENTS_CAPABILITY
  | typeof ORGANIZATION_CAPABILITY
  | typeof CONSENT_CAPABILITY;

/**
 * Ask whether to scaffold one capability's screens.
 *
 * One seam for every screen set rather than one per set: a third capability's screens must be a new member
 * of {@link UiScreenSet} and nothing else, and a prompt-per-capability is exactly the shape that stops
 * being true.
 */
export type UiScreenPrompt = (request: { screens: UiScreenSet; suggestion: boolean }) => Promise<boolean>;

/** What decides the screen sets: the backend Worker, its config, and the flags. */
export interface ScreenChoices {
  /** The project root. */
  projectDir: string;
  /** The backend Worker's directory, `apps/<name>`. */
  workerDir: string;
  /** The backend Worker's loaded `pithy.config.ts`. */
  config: WorkerConfig;
  /** `--auth` / `--no-auth`. Undefined means "decide". */
  auth?: boolean;
  /** `--payments` / `--no-payments`. */
  payments?: boolean;
  /** `--organization` / `--no-organization`. */
  organization?: boolean;
  /** `--consent` / `--no-consent`. */
  consent?: boolean;
  /** Asks a human. Supplied only when one is attached. */
  prompt?: UiScreenPrompt;
  /**
   * The screen sets this stub writes against the sign-in screens' session. Without the sign-in screens one of them
   * is refused when asked for and left out otherwise.
   */
  needsAuth?: readonly UiScreenSet[];
}

/** What each screen set is called in a refusal. */
const SCREEN_NAMES: Record<UiScreenSet, string> = {
  auth: "The sign-in screens",
  payments: "The paywall",
  organization: "The account chooser",
  consent: "The consent settings screen",
};

/** The screen sets one run writes. */
export interface ScreenSets {
  auth: boolean;
  payments: boolean;
  organization: boolean;
  consent: boolean;
  /** The agent screens, which ride on `auth` and the Worker composing `mcp`, with no flag of their own. */
  mcp: boolean;
}

/** Whether a worker composes a capability by name. */
export function composes(config: WorkerConfig, capability: string): boolean {
  return allCapabilities(config).some((composed) => composed.name === capability);
}

/**
 * Whether to write one capability's screens. A flag decides outright. With none, a human is asked (defaulting
 * to yes when the capability is composed on the Worker) and anyone else — `--json`, an agent, CI — gets that
 * same default with no prompt, because no invocation may block.
 *
 * Asking for a capability's screens on a worker that does not compose it is an error, not a scaffold of
 * broken imports.
 */
async function resolveScreens(
  choices: ScreenChoices,
  screens: UiScreenSet,
  requested: boolean | undefined,
): Promise<boolean> {
  const composed = composes(choices.config, screens);
  let wanted = requested;
  if (wanted === undefined)
    wanted = choices.prompt ? await choices.prompt({ screens, suggestion: composed }) : composed;
  if (wanted && !composed) {
    const worker = workerDirName({ dir: choices.workerDir });
    throw capabilityNotComposed(
      screens,
      {
        message: `The ${screens} screens need the ${screens} capability, and ${worker} doesn't compose it.`,
        action: (add) => `Run ${add} first, or leave them out with --no-${screens}.`,
      },
      { projectDir: choices.projectDir, workerDir: choices.workerDir },
    );
  }
  return wanted;
}

/** Every screen set one run writes, asked in a fixed order. */
export async function resolveScreenSets(choices: ScreenChoices): Promise<ScreenSets> {
  const auth = await resolveScreens(choices, AUTH_CAPABILITY, choices.auth);
  const gated = async (screens: UiScreenSet, requested: boolean | undefined): Promise<boolean> => {
    if (auth || !choices.needsAuth?.includes(screens)) return resolveScreens(choices, screens, requested);
    if (requested !== true) return false;
    throw new ValidationError({
      message: `${SCREEN_NAMES[screens]} needs the sign-in screens, and this run leaves them out.`,
      action: `Pass --auth, or leave ${SCREEN_NAMES[screens].toLowerCase()} out with --no-${screens}.`,
    });
  };
  const payments = await gated(PAYMENTS_CAPABILITY, choices.payments);
  const organization = await gated(ORGANIZATION_CAPABILITY, choices.organization);
  const consent = await gated(CONSENT_CAPABILITY, choices.consent);
  // The agent consent screen is where `mcp`'s authorization lands, so a Worker serving the endpoint without it
  // would send every agent's user to a page that does not exist.
  const mcp = auth && composes(choices.config, MCP_CAPABILITY);
  return { auth, payments, organization, consent, mcp };
}
