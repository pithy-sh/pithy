import {
  type ConnectedApplication,
  listConnectedApplications,
  revokeConnectedApplication,
} from "@pithy-sh/auth/src/client/mcp";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { useState } from "react";
import "../../pithy-screens.css";

export const path = "/connected-applications";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Revoking is the only narrowing a person has.** Consent is one decision with nothing to deselect, so "I do not
// want it doing that" has exactly one answer, and it must be reachable without asking an administrator. Link to
// this screen from your account settings. A revoked application's next call is refused.
//
// Each application is shown by the name it gave itself — unverified, as on the consent screen — by the host that
// serves its metadata document when it has one, which is checked, and by where its access goes.

/** Where the MCP capability mounts. Change this if `mcp({ path })` does. */
const MCP_PATH = "/mcp";

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/connected.title": "Applications acting as you",
  "auth/connected.empty": "None. Nothing is acting as you.",
  "auth/connected.unnamed": "An application with no name",
  "auth/connected.verified": "Published at {host}. That is checked.",
  "auth/connected.approved": "Approved {date}. Access goes to {redirect}.",
  "auth/connected.revoke": "Revoke",
  "auth/connected.failed": "We couldn't load your applications.",
  "auth/connected.retry": "Try again",
} satisfies MessageCatalog;

export default function ConnectedApplications() {
  const t = useTranslator(EN);
  const listed = useRead("connected-applications", () => listConnectedApplications({ basePath: MCP_PATH }));
  const [revokeFailed, setRevokeFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const applications: readonly ConnectedApplication[] | null = listed.value?.ok ? listed.value.value : null;

  async function revoke(clientId: string): Promise<void> {
    setBusy(clientId);
    const result = await revokeConnectedApplication(clientId, { basePath: MCP_PATH });
    setBusy(null);
    if (!result.ok) return setRevokeFailed(true);
    listed.refresh();
  }

  function retry(): void {
    setRevokeFailed(false);
    listed.refresh();
  }

  if (revokeFailed || (listed.value?.ok === false && !listed.loading)) {
    return (
      <main className="screen">
        <div className="stack">
          <p>{t.t("auth/connected.failed")}</p>
          <button type="button" className="secondary" onClick={retry}>
            {t.t("auth/connected.retry")}
          </button>
        </div>
      </main>
    );
  }
  if (applications === null) return <main className="screen" />;

  return (
    <main className="screen">
      <div className="stack">
        <h1>{t.t("auth/connected.title")}</h1>
        {applications.length === 0 ? <p className="muted">{t.t("auth/connected.empty")}</p> : null}
        <ul className="connected">
          {applications.map((application) => (
            <li key={application.clientId} className="connected__application">
              <span>{application.reportedName ?? t.t("auth/connected.unnamed")}</span>
              {application.verifiedHost == null ? null : (
                <span>{t.t("auth/connected.verified", { host: application.verifiedHost })}</span>
              )}
              <span className="muted">
                {t.t("auth/connected.approved", {
                  date: t.formatDate(new Date(application.approvedAt)),
                  redirect: application.redirectUris.join(", "),
                })}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={busy === application.clientId}
                onClick={() => void revoke(application.clientId)}
              >
                {t.t("auth/connected.revoke")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
