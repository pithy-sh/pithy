import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useState } from "react";
import { signOut } from "../../session";
import "../../pithy-screens.css";

export const path = "/account-suspended";

// Where a suspended account is sent: the sign-in and callback screens route here on
// `auth/account_suspended`, by this role rather than by the path above, so renaming the path moves both.
export const role = "account-suspended";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **The reason is not on this screen, and that is deliberate.** The operator's reason reaches the person in
// the email the suspension sent, and in the `message` of every refusal their app receives. It does not ride
// in this page's URL: a sentence read off a query parameter is a sentence anybody can write, and this page
// is on your domain. So the screen says what happened, what it means, and where the details are.

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/suspended.title": "Your account is suspended.",
  "auth/suspended.body": "You cannot sign in or use this app while it is suspended.",
  "auth/suspended.detail": "We emailed the reason to the address on your account.",
  "auth/suspended.contact": "If you think this is a mistake, reply to that email.",
  "auth/suspended.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function AccountSuspended() {
  const t = useTranslator(EN);
  const [busy, setBusy] = useState(false);

  return (
    <main className="screen">
      <h1>{t.t("auth/suspended.title")}</h1>
      <p>{t.t("auth/suspended.body")}</p>
      <p className="muted">{t.t("auth/suspended.detail")}</p>
      <p className="muted">{t.t("auth/suspended.contact")}</p>
      <div className="stack">
        {/* A session may still be on this device; ending it is what lets somebody else sign in here. */}
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut();
          }}
        >
          {t.t("auth/suspended.sign_out")}
        </button>
      </div>
    </main>
  );
}
