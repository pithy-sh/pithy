// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { TranslatorProvider } from "@pithy-sh/i18n/src/react/translator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

/**
 * The one-time-code screen, rendered — for the count in its first sentence, and for the seam it reads
 * its language through.
 *
 * ## The count
 *
 * The sentence used to be `We sent {authConfig.otpLength} digits to {email}` — a number concatenated
 * onto a plural noun, which is not a plural form in any language and is wrong in English the moment
 * `otpLength` is 1. It goes through `t.plural` now, so the catalog picks `.one` or `.other` by the
 * locale's own rules. **This file configures a length of one**, which is the only value that tells the
 * two implementations apart: at six they render the same string, and every existing assertion about
 * this screen was written at six.
 *
 * ## The seam
 *
 * This screen takes **no `t` prop** — it is a route module, not a component something else composes,
 * so nothing can hand it one. It reads `useTranslator(EN)`, which is the context when a
 * `TranslatorProvider` is mounted over it and the baked English when none is. Both are asserted here,
 * and between them they are the whole of what makes the capability optional: a project composing
 * `i18n` reads Spanish, and a project composing nothing reads the English it was scaffolded with.
 *
 * `../templates/src/pithy-config` is mocked because it is the input — the length is config, and this
 * is a case about a specific value of it.
 */

/** The digit count this screen is configured for. One, because one is where a bad plural shows. */
const OTP_LENGTH = 1;

vi.mock("../templates/src/pithy-config", () => ({
  authConfig: {
    enabled: true,
    basePath: "/auth",
    providers: { google: false, apple: false, facebook: false, github: false },
    otpLength: OTP_LENGTH,
    signUpEnabled: true,
  },
  turnstileConfig: {
    enabled: false,
    sitekey: "",
    action: "",
    mode: "visible" as const,
    token: { field: "cf-turnstile-response", header: null },
  },
}));

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { unmount: () => void } | null = null;

async function render(node: ReactNode): Promise<string> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container.textContent ?? "";
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

test("counts the digits it asked for in the form the language has for that count", async () => {
  const { default: Otp } = await import("../templates/src/routes/pithy/otp");
  const text = await render(<Otp />);
  // Singular, because one digit was asked for. The concatenated version reads "1 digits", which is the
  // exact state this gate exists in for — and it is a sentence nobody would have caught at six.
  expect(text, "the count is concatenated onto a plural noun rather than selecting a form").toContain(
    "We sent 1 digit to",
  );
  expect(text).not.toContain("1 digits");
});

test("reads the language a provider mounted over it, having no prop to be handed one on", async () => {
  const { default: Otp } = await import("../templates/src/routes/pithy/otp");
  // Spanish, over the kit's catalog alone — no English layer behind it, so an untranslated key would
  // render as the key rather than quietly reading well in English.
  const text = await render(
    <TranslatorProvider value={{ catalogLocale: "es", formattingLocale: "es", layers: [KIT_CATALOGS.es] }}>
      <Otp />
    </TranslatorProvider>,
  );
  // Read from the catalog, interpolated the way the screen interpolates it: a Spanish sentence written
  // down here would be a second copy of the translation and the first thing to drift from it.
  const sent = KIT_CATALOGS.es?.[`auth/otp.sent.${OTP_LENGTH === 1 ? "one" : "other"}`];
  const inbox = KIT_CATALOGS.es?.["auth/otp.inbox"];
  expect(sent, "the kit ships no Spanish for the one-time code screen's first sentence").toBeTypeOf("string");
  expect(inbox).toBeTypeOf("string");
  expect(text).toContain((sent ?? "").replace("{count}", String(OTP_LENGTH)).replace("{email}", inbox ?? ""));
  // And it is not quietly English: the assertion above is a `toContain`, and a screen that never read
  // the provider would still have to fail this one.
  expect(text).not.toContain("We sent");
});
