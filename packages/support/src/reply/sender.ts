// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import { isEmailCapability } from "@pithy-sh/email/src/capability";
import type { SupportConfig } from "../config/config";
import { claimedSenders } from "./fromName";

/** The `@pithy-sh/email` range whose capability carries `enqueueAs`. */
export const EMAIL_WITH_ENQUEUE_AS = "^0.9.0";

/**
 * The enqueue a reply is sent through: the composed email capability's `enqueueAs`, bound to the addresses
 * support claims. Undefined when no email capability is composed, which degrades the reply route alone.
 *
 * An email capability with no `enqueueAs` is a release older than the seam, and is refused here, at compose,
 * rather than failing every reply.
 */
export function replySender(
  capabilities: readonly Capability[],
  config: SupportConfig,
): EmailCapability["enqueue"] | undefined {
  const email = capabilities.find(isEmailCapability);
  if (!email) return undefined;
  if (typeof email.enqueueAs !== "function") {
    throw new InternalError({
      message: "The composed email capability is too old to send support replies.",
      action: `Upgrade @pithy-sh/email to ${EMAIL_WITH_ENQUEUE_AS}, the release that carries enqueueAs, then redeploy.`,
      detail: "email capability composed without enqueueAs",
    });
  }
  return email.enqueueAs(claimedSenders(config));
}
