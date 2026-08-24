import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { signOut, useSession } from "../../session";

// Your screen. Pithy wrote this file once and never will again — everything under src/routes/app/ is
// yours. Add a screen by dropping a file in beside it with its own `path` export.
export const path = "/";

// Signed-out visitors are sent to /sign-in. Delete this line to make the screen public.
export const session = "required";

/**
 * This screen's English, baked in. Yours, like the rest of the file.
 *
 * Keyed under `app/` because this screen is yours rather than a capability's — a capability may only
 * declare keys under its own name, and none of them is called `app`. Add your own keys here and they
 * translate through the same layers the kit's do.
 */
const EN = {
  "app/home.title": "You're in.",
  "app/home.signed_in_as": "Signed in as {email}.",
  "app/home.someone": "someone",
  "app/home.sign_out": "Sign out",
} satisfies MessageCatalog;

export default function Home() {
  const t = useTranslator(EN);
  const { session: current } = useSession();

  return (
    <main className="screen">
      <h1>{t.t("app/home.title")}</h1>
      <p className="muted">{t.t("app/home.signed_in_as", { email: current?.user.email ?? t.t("app/home.someone") })}</p>
      <div className="stack">
        <button type="button" className="secondary" onClick={() => void signOut()}>
          {t.t("app/home.sign_out")}
        </button>
      </div>
    </main>
  );
}
