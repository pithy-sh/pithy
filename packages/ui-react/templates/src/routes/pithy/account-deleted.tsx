import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useState } from "react";
import { signOut } from "../../session";
import "../../pithy-screens.css";

export const path = "/account-deleted";

// Where a deleted account is sent: the sign-in and callback screens route here on `auth/account_deleted`,
// by this role rather than by the path above, so renaming the path moves both.
export const role = "account-deleted";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **The purge date is in the email, not here.** The deletion mailed it to the address on the account, and a
// date read off this page's URL would be one anybody could write. So the screen says what is true for every
// deleted account: it cannot sign in, it can still come back for a while, and the email says until when.

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/deleted.title": "Your account is deleted.",
  "auth/deleted.body": "You cannot sign in. Its data is erased when the deletion window closes.",
  "auth/deleted.detail": "Until then it can be restored. We emailed the date to the address on your account.",
  "auth/deleted.contact": "To restore it, reply to that email before then.",
  "auth/deleted.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function AccountDeleted() {
  const t = useTranslator(EN);
  const [busy, setBusy] = useState(false);

  return (
    <main className="screen">
      <h1>{t.t("auth/deleted.title")}</h1>
      <p>{t.t("auth/deleted.body")}</p>
      <p className="muted">{t.t("auth/deleted.detail")}</p>
      <p className="muted">{t.t("auth/deleted.contact")}</p>
      <div className="stack">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut();
          }}
        >
          {t.t("auth/deleted.sign_out")}
        </button>
      </div>
    </main>
  );
}
