import { type ConsentClient, type ConsentClientOptions, consentClient } from "@pithy-sh/consent/src/client/api";
import type { MyConsentResponse } from "@pithy-sh/consent/src/http/responses";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import "../../pithy-screens.css";

export const path = "/consent";

// What a "your privacy choices" link points at, wherever it sits — by this role, so renaming the path moves it.
export const role = "consent";

// No `session` export: a visitor who has not signed in reads and changes their choices here too, against the
// device id their first choice set. Signed in, it is their account's.

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

/**
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * **Withdrawing is never harder than granting.** Every purpose a click grants, a click withdraws, on the same row.
 * A purpose that needs a signature is signed where its document is shown — this screen cannot render your notice.
 * When the purpose asks for a written withdrawal, it is withdrawn at the grade it was signed at, because the server
 * refuses anything less: here by typing a name for a typed grant, here by drawing for a drawn one, and for a grant
 * signed through a provider, where it was signed. A click grant is always withdrawn by a click.
 */
const EN = {
  "consent/settings.title": "Your privacy choices.",
  "consent/settings.loading": "One moment.",
  "consent/settings.unreadable": "We couldn't load your choices.",
  "consent/settings.none": "Nothing here asks for your consent.",
  "consent/settings.on": "On.",
  "consent/settings.off": "Off.",
  "consent/settings.renew": "The notice changed. Agree again to keep this on.",
  "consent/settings.expired": "This has expired.",
  "consent/settings.agree": "Agree",
  "consent/settings.withdraw": "Withdraw",
  "consent/settings.signed_elsewhere": "This needs your signature on the document it covers.",
  "consent/settings.type_name": "Type your full name to withdraw in writing",
  "consent/settings.draw_name": "Sign below to withdraw in writing",
  "consent/settings.clear": "Clear",
  "consent/settings.signed_with_provider":
    "You signed this through an e-signature service. Withdraw it where you signed it.",
  "consent/settings.saved": "Saved.",
} satisfies MessageCatalog;

/** One row of the screen: a purpose, and where the reader stands on it. */
type Row = MyConsentResponse["purposes"][number];

/** What to say about where the reader stands. */
function standingText(t: Translator, row: Row): string {
  if (row.granted) return t.t("consent/settings.on");
  if (row.standing === "stale_notice" || row.standing === "below_minimum") return t.t("consent/settings.renew");
  if (row.standing === "expired" || row.standing === "visitor_expired") return t.t("consent/settings.expired");
  return t.t("consent/settings.off");
}

/**
 * A refusal in the reader's language: the code's own sentence where a catalog has one, and the server's English
 * where none does — the order `docs/I18N.md` gives, and the one `failureText` in `src/payments.tsx` keeps.
 */
function refusalText(t: Translator, refusal: { code: string; message: string }): string {
  const { code, message: english } = refusal;
  return t.maybe(code) ?? english;
}

/** The latest grant behind a purpose, for a written withdrawal's grade. */
function grantMethod(me: MyConsentResponse, purpose: string): string | null {
  const grants = me.records.filter((record) => record.purpose === purpose && record.action === "grant");
  return grants.at(-1)?.method ?? null;
}

/** How a granted purpose is withdrawn: a click, a typed name, a drawn signature, or where a provider took it. */
type Withdrawal = "click" | "typed" | "drawn" | "provider";

/** The withdrawal a row asks for: a click, unless the purpose requires one in writing at the grant's grade. */
function withdrawalFor(me: MyConsentResponse, row: Row): Withdrawal {
  if (!row.purpose.writtenWithdrawal) return "click";
  const method = grantMethod(me, row.purpose.id);
  return method === "typed" || method === "drawn" || method === "provider" ? method : "click";
}

/**
 * A drawn signature: a pointer draws on a canvas, and lifting it hands back the PNG as base64. Clear starts again.
 * The canvas is the whole of it — no library, nothing sent anywhere but the withdrawal it signs.
 */
function SignaturePad({
  label,
  clearLabel,
  onChange,
}: {
  label: string;
  clearLabel: string;
  onChange: (image: string | null) => void;
}): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    drawing.current = true;
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    const { x, y } = point(event);
    context?.lineTo(x, y);
    context?.stroke();
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    const [, image] = event.currentTarget.toDataURL("image/png").split(",");
    onChange(image ? image : null);
  };
  const clear = () => {
    const element = canvas.current;
    element?.getContext("2d")?.clearRect(0, 0, element.width, element.height);
    onChange(null);
  };
  return (
    <div className="stack">
      <span>{label}</span>
      <canvas
        ref={canvas}
        width={320}
        height={96}
        aria-label={label}
        style={{ border: "1px solid currentColor", touchAction: "none", maxWidth: "100%" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <button type="button" className="secondary" onClick={clear}>
        {clearLabel}
      </button>
    </div>
  );
}

export interface ConsentScreenProps {
  /** The translator this screen renders through. Absent, the provider's, and with none, {@link EN}. */
  readonly t?: Translator;
  /** Where the consent routes are, and the fetch to reach them with. Injected so a test never navigates. */
  readonly client?: ConsentClientOptions;
}

/**
 * The consent settings screen: every purpose and where the reader stands. A click-level purpose is granted here; a
 * grant is withdrawn here the way it was given, except one signed with a provider, which is withdrawn there.
 */
/** A refusal carried as the read's failure, so the last answer survives it. */
class Refused extends Error {
  constructor(readonly refusal: { code: string; message: string }) {
    super(refusal.code);
  }
}

export function ConsentScreen({ client: options, t: given }: ConsentScreenProps): ReactNode {
  const baked = useTranslator(EN);
  const t = given ?? baked;
  const [client] = useState<ConsentClient>(() => consentClient(options));
  const read = useRead("consent", async (): Promise<MyConsentResponse> => {
    const result = await client.me();
    if (result.ok) return result.value;
    throw new Refused(result);
  });
  const me = read.value ?? null;
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  // `client.me()` answers a refusal rather than throwing, so a refusal is the only failure the read carries.
  const failure = refusal ?? (read.failure instanceof Refused ? read.failure.refusal : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [drawings, setDrawings] = useState<Record<string, string | null>>({});
  const [saved, setSaved] = useState(false);

  const choose = async (row: Row, grant: boolean) => {
    setBusy(row.purpose.id);
    setSaved(false);
    const withdrawal = me ? withdrawalFor(me, row) : "click";
    const typedName = names[row.purpose.id]?.trim();
    const drawn = drawings[row.purpose.id];
    const evidence =
      withdrawal === "typed" && typedName
        ? { method: "typed" as const, typedName }
        : withdrawal === "drawn" && drawn
          ? { method: "drawn" as const, drawn: { image: drawn, type: "image/png" as const } }
          : { method: "click" as const };
    const result = grant
      ? await client.grant({
          purpose: row.purpose.id,
          noticeVersion: row.purpose.noticeVersion,
          method: "click",
          surface: "settings",
        })
      : await client.withdraw({
          purpose: row.purpose.id,
          method: evidence.method,
          surface: "settings",
          ...("typedName" in evidence ? { typedName: evidence.typedName } : {}),
          ...("drawn" in evidence ? { drawn: evidence.drawn } : {}),
        });
    setBusy(null);
    if (result.ok) {
      setSaved(true);
      setRefusal(null);
      read.refresh();
    } else {
      setRefusal(result);
    }
  };

  if (me === null && failure === null) return <p className="muted">{t.t("consent/settings.loading")}</p>;

  return (
    <main className="screen">
      <h1>{me === null ? t.t("consent/settings.unreadable") : t.t("consent/settings.title")}</h1>
      {failure && <p className="muted">{refusalText(t, failure)}</p>}
      {me !== null && me.purposes.length === 0 && <p className="muted">{t.t("consent/settings.none")}</p>}
      {me?.purposes.map((row) => {
        const clickable = row.purpose.minimumMethod === "click";
        const withdrawal = withdrawalFor(me, row);
        const ready =
          withdrawal === "typed"
            ? Boolean(names[row.purpose.id]?.trim())
            : withdrawal === "drawn"
              ? Boolean(drawings[row.purpose.id])
              : true;
        return (
          <div className="stack" key={row.purpose.id}>
            <p>
              <strong>{row.purpose.summary}</strong> <span className="muted">{standingText(t, row)}</span>
            </p>
            {row.granted && withdrawal === "provider" ? (
              <p className="muted">{t.t("consent/settings.signed_with_provider")}</p>
            ) : row.granted ? (
              <>
                {withdrawal === "typed" && (
                  <label>
                    {t.t("consent/settings.type_name")}
                    <input
                      autoComplete="name"
                      value={names[row.purpose.id] ?? ""}
                      onChange={(event) => setNames({ ...names, [row.purpose.id]: event.target.value })}
                    />
                  </label>
                )}
                {withdrawal === "drawn" && (
                  <SignaturePad
                    label={t.t("consent/settings.draw_name")}
                    clearLabel={t.t("consent/settings.clear")}
                    onChange={(image) => setDrawings((current) => ({ ...current, [row.purpose.id]: image }))}
                  />
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || !ready}
                  onClick={() => void choose(row, false)}
                >
                  {t.t("consent/settings.withdraw")}
                </button>
              </>
            ) : clickable ? (
              <button type="button" disabled={busy !== null} onClick={() => void choose(row, true)}>
                {t.t("consent/settings.agree")}
              </button>
            ) : (
              <p className="muted">{t.t("consent/settings.signed_elsewhere")}</p>
            )}
          </div>
        );
      })}
      {saved && <p className="muted">{t.t("consent/settings.saved")}</p>}
    </main>
  );
}

export default function Consent(): ReactNode {
  return <ConsentScreen />;
}
