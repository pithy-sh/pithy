// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProcessingActivityInput, ProcessingRecipientInput } from "@pithy-sh/core/src/processing/activity";
import { EMAIL_MARKETING_PURPOSE, EMAIL_TRACKING_PURPOSE } from "../consent/consent";

/** The mail provider every send goes through. */
const EMAIL_SERVICE: ProcessingRecipientInput = {
  name: "Cloudflare Email Service",
  receives: "Each recipient's address and the message sent to it.",
  classes: ["pii"],
};

/**
 * What email does with personal data: it sends the mail the Worker enqueues, and, under each purpose's consent,
 * marketing mail and open and click tracking.
 */
export const EMAIL_PROCESSING: readonly ProcessingActivityInput[] = [
  {
    id: "email.delivery",
    purpose: "Send the mail a person's account needs — sign-in links, codes, notices — and keep its history.",
    classes: ["pii"],
    legalBasis: "contract",
    recipients: [EMAIL_SERVICE],
  },
  {
    id: "email.marketing",
    purpose: "Send news and offers by email to a person who agreed to receive them.",
    classes: ["pii"],
    legalBasis: "consent",
    consentPurpose: EMAIL_MARKETING_PURPOSE,
    recipients: [EMAIL_SERVICE],
  },
  {
    id: "email.tracking",
    purpose: "Record when a person opens a message or follows a link in it, for a person who agreed to it.",
    classes: ["pii"],
    legalBasis: "consent",
    consentPurpose: EMAIL_TRACKING_PURPOSE,
  },
];
