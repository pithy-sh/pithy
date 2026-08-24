// @vitest-environment happy-dom

import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

/**
 * **The document may not declare a language the page does not speak.**
 *
 * `client.tsx` negotiated a locale and put it on `<html lang>`, and nothing mounted a translator behind
 * it. A project composing `i18n` therefore served `<html lang="es">` over a page rendering the English
 * every screen bakes — and that is worse than leaving `lang="en"` alone, because assistive technology
 * believes the attribute: a screen reader switches voice and pronounces English with Spanish phonetics.
 *
 * `src/pithy-locale.tsx` is what makes the two one statement, and this is the gate that keeps them one
 * after the file is yours. Both halves are asserted from a single mount, which is the whole point — a
 * test that checked them separately would pass on a page where each was independently reasonable.
 *
 * ## What this proves, and how it goes red
 *
 * The projection is mocked to negotiate a locale the kit has a real translation for, and a probe screen
 * is rendered underneath with **invented** English baked into it. The probe's rendered text must be the
 * kit's Spanish and not the English it carries, and `document.documentElement.lang` must be the same
 * locale that produced those words. Delete the provider and the probe renders its baked English; delete
 * the negotiation and `lang` never moves. Either way this goes red.
 *
 * The invented English is what makes the first assertion mean anything: a plausible sentence could
 * coincide with a catalog entry, and then a page that mounted no provider at all would still pass.
 *
 * `./pithy-config` is mocked for the reason `src/turnstile.test.tsx` and `src/routes/pithy/sign-in.test.tsx`
 * mock it — it imports the `virtual:pithy/*` modules, which only a Vite build serves. Mocked here it is
 * also the input: this is the one gate whose subject is what the projection says.
 */

/** The locale the mocked projection negotiates. Not `en`, on purpose — see below. */
const CANARY_LOCALE = "es";

/** The key the probe renders. Base-group copy: `router.tsx` says it while a route loads. */
const KEY = "app/loading";

/** What the probe bakes for {@link KEY}. Invented here, so no catalog can answer with it by accident. */
const CANARY_ENGLISH = "pithy-gate-canary-untranslated";

vi.mock("./pithy-config", () => ({
  i18nConfig: {
    enabled: true,
    supportedLocales: [CANARY_LOCALE],
    defaultLocale: CANARY_LOCALE,
    queryParam: "lang",
    storageKey: "pithy.locale",
    // Only the link that cannot read a global, so this case is about the wiring and not about whatever
    // a test environment happens to have in `localStorage` or on the URL.
    browserResolvers: ["default"],
    exceptions: {},
  },
}));

// React refuses to run `act` unless the environment says it is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * How long the catalog gets to land, and how long each poll waits.
 *
 * **A deadline in milliseconds, waited on — not a fixed number of turns, and not no wait at all.** The
 * catalog arrives by dynamic `import()`, so how long it takes is the machine's answer and not this
 * file's: a cold import plus its transform under a loaded CI runner is orders of magnitude slower than
 * a warm one, and this file is copied into every adopter's repository, where the first `vitest run`
 * after scaffolding is the coldest run that will ever happen there. A gate that reds on a file the
 * adopter never wrote is a gate they delete.
 *
 * Ten seconds is hundreds of times the measured cold cost, and the case below states its own 30s
 * timeout so the deadline is what reports the failure rather than Vitest's default five — which the
 * kit raises for its own suites and an adopter's runner does not.
 */
const SETTLE_DEADLINE_MS = 10_000;
const SETTLE_POLL_MS = 5;
const CASE_TIMEOUT_MS = 30_000;

/**
 * Wait until the translator has mounted, rather than assuming it has by now.
 *
 * The transition **is** the signal: until the catalog lands the tree renders {@link CANARY_ENGLISH},
 * and the whole assertion is that it stops. Polling on a macrotask rather than flushing microtasks,
 * because `loadKitCatalog` is a real `import()` and Vitest resolves that off the module graph rather
 * than out of the current tick.
 */
async function untilTranslated(container: HTMLElement): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (container.textContent === CANARY_ENGLISH) {
    if (Date.now() > deadline) {
      throw new Error(
        `The tree still renders its baked English after ${SETTLE_DEADLINE_MS}ms — no translator was mounted over it.`,
      );
    }
    await act(async () => {
      await new Promise((resume) => setTimeout(resume, SETTLE_POLL_MS));
    });
  }
}

/** A screen, as every seeded screen is written: one key, and the English it was scaffolded with. */
function Probe(): ReactNode {
  const t = useTranslator({ [KEY]: CANARY_ENGLISH });
  return t.t(KEY);
}

test(
  "the page renders the language the document declares",
  async () => {
    // The canary, refused. Run this at `en` and it passes against the exact defect it exists to catch:
    // a page with no provider at all renders English, and `lang="en"` agrees with it.
    expect(CANARY_LOCALE).not.toBe("en");
    // And the kit really translates the key, so "not the baked English" is a reachable state.
    const translated = KIT_CATALOGS[CANARY_LOCALE]?.[KEY];
    expect(translated, `the kit ships no ${CANARY_LOCALE} for ${KEY}`).toBeTypeOf("string");
    expect(translated).not.toBe(CANARY_ENGLISH);

    const { PithyLocale } = await import("./pithy-locale");
    const container = document.body.appendChild(document.createElement("div"));
    await act(async () => {
      createRoot(container).render(
        <PithyLocale>
          <Probe />
        </PithyLocale>,
      );
    });

    // The catalog arrives by dynamic import, so the provider mounts some time after the first paint —
    // how long is the machine's answer, not this file's. Waited on rather than counted out.
    await untilTranslated(container);

    expect(container.textContent, "the tree rendered its baked English — no translator was mounted over it").toBe(
      translated,
    );
    expect(document.documentElement.lang, "the document declares a language nothing negotiated").toBe(CANARY_LOCALE);
  },
  CASE_TIMEOUT_MS,
);
