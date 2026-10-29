import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { Link } from "../../router";
import "../../pithy-screens.css";

export const path = "/organization-suspended";

// Where somebody is sent when the organization they act for is suspended, and their own account is not.
export const role = "organization-suspended";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// Arrived at by role: the chooser sends a member here when acting for their organization is refused with
// `organization/organization_suspended`; your screens can do the same with `organizationRefusal` from
// `@pithy-sh/organization/src/client/lifecycle`. It names nobody: the organization's owners were told why.

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "organization/suspended.title": "This organization is suspended.",
  "organization/suspended.body": "Nobody can use it until it is reinstated. Your own account is not affected.",
  "organization/suspended.contact": "Its owners were told why. Ask one of them.",
  "organization/suspended.home": "Go home",
} satisfies MessageCatalog;

/**
 * Where "home" is. The app's root, and deliberately not a `ScreenRole`: nothing guards its way there. An
 * adopter whose home is elsewhere changes this line, which is the one edit a copied screen is for.
 */
const HOME = "/";

export default function OrganizationSuspended() {
  const t = useTranslator(EN);

  return (
    <main className="screen">
      <h1>{t.t("organization/suspended.title")}</h1>
      <p>{t.t("organization/suspended.body")}</p>
      <p className="muted">{t.t("organization/suspended.contact")}</p>
      <div className="stack">
        <Link to={HOME}>{t.t("organization/suspended.home")}</Link>
      </div>
    </main>
  );
}
