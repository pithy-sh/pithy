import { type ConsentView, decideConsent, readConsent } from "@pithy-sh/auth/src/client/mcp";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useEffect, useState } from "react";
import { authConfig } from "../../pithy-config";
import { navigate, routeTable, screenPath } from "../../router";
import { getSession, RESUME_PARAM } from "../../session";
import "../../pithy-screens.css";

export const path = "/agent-consent";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **An application is asking to act as you, and this is the one place a mistake here is irreversible.** Read this
// before restyling it.
//
// **The application's name is whatever it said it was.** Anybody can register a client and call it "POWERPLAY
// Official Sync"; nothing has checked it. So the name is shown as reported, in ordinary weight, and the emphasis goes
// to the one thing that cannot be spoofed: where the access goes — the redirect address, which the authorization
// server enforces. Making the name the headline is how this screen becomes a phishing page you shipped.
//
// **One decision, and nothing to tick.** Approving lets the application act as you in this app. The list is the
// consequence — what it will then be able to do, per capability, in each capability's own words — and it only ever
// lists what your role allows. Your role stays the ceiling: approving everything still never grants more than it.
//
// **Not signed in?** The authorization server sends people here to sign in too. The screen sends you to sign in
// with the request in the URL, and the sign-in resumes it.

/** Where the MCP capability mounts. Change this if `mcp({ path })` does. */
const MCP_PATH = "/mcp";

/** This screen's English, baked in — the only catalog that survives being copied into your repository. */
const EN = {
  "auth/consent.title": "An application wants to act as you.",
  "auth/consent.reported": "It calls itself {name}. That name is its own, and nobody has checked it.",
  "auth/consent.unnamed": "It gave no name.",
  "auth/consent.redirect": "Access will be sent to",
  "auth/consent.redirect_note": "Approve only if you started this from that application.",
  "auth/consent.can_do": "If you approve, it can:",
  "auth/consent.count.one": "{reachable} of {count} operation in {capability}.",
  "auth/consent.count.other": "{reachable} of {count} operations in {capability}.",
  "auth/consent.withheld.one": "{count} more needs a role you do not hold.",
  "auth/consent.withheld.other": "{count} more need a role you do not hold.",
  "auth/consent.nothing": "Your role allows it nothing here yet. It gains what your role gains.",
  "auth/consent.refused_scope": "{scope}: {reason}",
  "auth/consent.not_granted.role": "Requested, and not granted, because your role does not include it.",
  "auth/consent.not_granted.unknown": "Requested, and not granted, because this application has no such permission.",
  "auth/consent.bound":
    "Approving lets this application act as you. It can never do more than your role allows, and it loses anything your role loses.",
  "auth/consent.approve": "Let it act as me",
  "auth/consent.deny": "Don't allow",
  "auth/consent.expired": "This request has expired. Start again from the application.",
  "auth/consent.effect.writes": "changes data",
  "auth/consent.effect.sends": "sends a message",
  "auth/consent.effect.charges": "charges money",
  "auth/consent.effect.deletes": "deletes data",
} satisfies MessageCatalog;

/** The authorization request again, unsigned, so a sign-in can resume it and the server sign it afresh. */
function authorizeAgain(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) params.delete(key);
  return `${authConfig.basePath}/oauth2/authorize?${params}`;
}

export default function Consent() {
  const t = useTranslator(EN);
  const query = window.location.search.replace(/^\?/, "");
  const [view, setView] = useState<ConsentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if ((await getSession()) === null) {
        const resume = new URLSearchParams({ [RESUME_PARAM]: authorizeAgain(query) });
        navigate(`${screenPath(await routeTable(), "sign-in")}?${resume}`);
        return;
      }
      const result = await readConsent(query, { basePath: MCP_PATH });
      if (result.ok) setView(result.value);
      else setFailed(true);
    })();
  }, [query]);

  async function decide(accept: boolean): Promise<void> {
    setBusy(true);
    const result = await decideConsent(query, accept, { basePath: MCP_PATH });
    if (!result.ok) {
      setBusy(false);
      setFailed(true);
      return;
    }
    // The application's own address, with a code or a refusal: a document load, because it is not this app.
    window.location.assign(result.value.redirect);
  }

  if (failed) {
    return (
      <main className="screen">
        <p>{t.t("auth/consent.expired")}</p>
      </main>
    );
  }
  if (view === null) return <main className="screen" />;

  return (
    <main className="screen">
      <div className="stack">
        <h1>{t.t("auth/consent.title")}</h1>
        <p className="muted">
          {view.client.reportedName === null
            ? t.t("auth/consent.unnamed")
            : t.t("auth/consent.reported", { name: view.client.reportedName })}
        </p>
        <p>
          {t.t("auth/consent.redirect")} <strong className="consent__redirect">{view.client.redirectUri}</strong>
        </p>
        <p className="muted">{t.t("auth/consent.redirect_note")}</p>

        {view.capabilities.length === 0 ? (
          <p>{t.t("auth/consent.nothing")}</p>
        ) : (
          <>
            <p>{t.t("auth/consent.can_do")}</p>
            {view.capabilities.map((row) => (
              <section key={row.capability} className="consent__capability">
                <h2>{row.capability}</h2>
                <ul>
                  {row.operations.map((operation) => (
                    <li key={operation.tool}>
                      {operation.summary}
                      {operation.effect === null ? null : (
                        <span className="muted"> — {t.t(`auth/consent.effect.${operation.effect}`)}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  {t.plural("auth/consent.count", row.total, {
                    reachable: String(row.reachable),
                    capability: row.capability,
                  })}
                  {row.total > row.reachable
                    ? ` ${t.plural("auth/consent.withheld", row.total - row.reachable)}`
                    : null}
                </p>
              </section>
            ))}
          </>
        )}

        {view.requested
          .filter((scope) => !scope.granted)
          .map((scope) => (
            <p key={scope.scope} className="muted">
              {t.t("auth/consent.refused_scope", {
                scope: scope.scope,
                reason: t.t(`auth/consent.not_granted.${scope.reason ?? "unknown"}`),
              })}
            </p>
          ))}

        <p className="muted">{t.t("auth/consent.bound")}</p>
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          {t.t("auth/consent.approve")}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void decide(false)}>
          {t.t("auth/consent.deny")}
        </button>
      </div>
    </main>
  );
}
