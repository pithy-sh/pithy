import { type ConsentClient, type ConsentClientOptions, consentClient } from "@pithy-sh/consent/src/client/api";
import type { MyConsentResponse } from "@pithy-sh/consent/src/http/responses";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { type ReactNode, useRef, useState } from "react";
import { type GestureResponderEvent, Pressable, Text, TextInput, View } from "react-native";
import { consentConfig } from "../../pithy-config";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";

export const path = "/consent";

// What a "your privacy choices" link points at, wherever it sits — by this role, so renaming the path moves it.
export const role = "consent";

// No `session` export: a visitor who has not signed in reads and changes their choices here too. On the web that is
// against the device id their first choice set in a cookie; a phone sends no cookie, so there a visitor's choices
// last only as long as the Worker can tell them apart. Signed in, they are their account's.

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

/**
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * **Withdrawing is never harder than granting.** Every purpose a press grants, a press withdraws, on the same row.
 * A purpose that needs a signature is signed where its document is shown — this screen cannot render your notice.
 * When the purpose asks for a written withdrawal, it is withdrawn at the grade it was signed at, because the server
 * refuses anything less: here by typing a name for a typed grant, here by drawing for a drawn one, and for a grant
 * signed through a provider, where it was signed. A click grant is always withdrawn by a press.
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

/** How a granted purpose is withdrawn: a press, a typed name, a drawn signature, or where a provider took it. */
type Withdrawal = "click" | "typed" | "drawn" | "provider";

/** The withdrawal a row asks for: a press, unless the purpose requires one in writing at the grant's grade. */
function withdrawalFor(me: MyConsentResponse, row: Row): Withdrawal {
  if (!row.purpose.writtenWithdrawal) return "click";
  const method = grantMethod(me, row.purpose.id);
  return method === "typed" || method === "drawn" || method === "provider" ? method : "click";
}

/**
 * The consent routes, under the base path the Worker composed them at, over this app's transport: the Worker's
 * origin and the bearer session's fetch on a phone.
 */
function consentTransport(): ConsentClientOptions {
  const basePath = consentConfig.basePath;
  const { origin, fetch } = transport.capability;
  if (origin === undefined || fetch === undefined) return { basePath };
  return { basePath, fetch: (path, init) => fetch(`${origin}${path}`, init) };
}

// ── the drawn signature ──────────────────────────────────────────────────────

/** A point on the pad, in the pad's own coordinates. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** The pad's size: the drawing's coordinates, and the SVG's. */
const PAD = { width: 320, height: 96 } as const;

/** One coordinate, kept on the pad and to a tenth of a point. */
function coordinate(value: number, limit: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(Math.max(finite, 0), limit) * 10) / 10;
}

/** The strokes as an SVG document: one path, a line through each stroke's points. */
function signatureSvg(strokes: readonly (readonly Point[])[]): string {
  const d = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const [first, ...rest] = stroke;
      if (!first) return "";
      const lines = rest.length === 0 ? ["l0 0"] : rest.map((point) => `L${point.x} ${point.y}`);
      return [`M${first.x} ${first.y}`, ...lines].join(" ");
    })
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAD.width}" height="${PAD.height}" viewBox="0 0 ${PAD.width} ${PAD.height}"><path d="${d}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 of ASCII text. The SVG above is ASCII by construction, so no character needs encoding first. */
function base64Ascii(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; at += 3) {
    const a = text.charCodeAt(at);
    const b = at + 1 < text.length ? text.charCodeAt(at + 1) : 0;
    const c = at + 2 < text.length ? text.charCodeAt(at + 2) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64.charAt((triple >> 18) & 63) + BASE64.charAt((triple >> 12) & 63);
    out += at + 1 < text.length ? BASE64.charAt((triple >> 6) & 63) : "=";
    out += at + 2 < text.length ? BASE64.charAt(triple & 63) : "=";
  }
  return out;
}

/** A segment of a stroke, drawn as a thin rotated bar between two points. */
function Segment(props: { from: Point; to: Point; color: string }): ReactNode {
  const { from, to } = props;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.hypot(dx, dy), 2);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (from.x + to.x) / 2 - length / 2,
        top: (from.y + to.y) / 2 - 1,
        width: length,
        height: 2,
        borderRadius: 1,
        backgroundColor: props.color,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

/**
 * A drawn signature: a finger or a pointer draws on the pad, and lifting it hands back the drawing as a base64 SVG.
 * Clear starts again. The pad is the whole of it — no library, nothing sent anywhere but the withdrawal it signs.
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
  const theme = useTheme();
  const strokes = useRef<Point[][]>([]);
  const [, setDrawn] = useState(0);
  const redraw = () => setDrawn((count) => count + 1);
  const point = (event: GestureResponderEvent): Point => ({
    x: coordinate(event.nativeEvent.locationX, PAD.width),
    y: coordinate(event.nativeEvent.locationY, PAD.height),
  });
  const down = (event: GestureResponderEvent) => {
    strokes.current = [...strokes.current, [point(event)]];
    redraw();
  };
  const move = (event: GestureResponderEvent) => {
    const stroke = strokes.current.at(-1);
    if (!stroke) return;
    stroke.push(point(event));
    redraw();
  };
  const up = () => {
    const drawn = strokes.current.some((stroke) => stroke.length > 0);
    onChange(drawn ? base64Ascii(signatureSvg(strokes.current)) : null);
  };
  const clear = () => {
    strokes.current = [];
    redraw();
    onChange(null);
  };
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{label}</Text>
      <View
        role="img"
        aria-label={label}
        style={{
          width: PAD.width,
          maxWidth: "100%",
          height: PAD.height,
          borderWidth: 1,
          borderColor: theme.colors.text,
          borderRadius: theme.radius,
          backgroundColor: theme.colors.surface,
          overflow: "hidden",
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={down}
        onResponderMove={move}
        onResponderRelease={up}
        onResponderTerminate={up}
      >
        {strokes.current.flatMap((stroke, index) =>
          stroke.map((at, step) => (
            <Segment
              // biome-ignore lint/suspicious/noArrayIndexKey: a stroke's points never reorder; the pad only appends.
              key={`${index}:${step}`}
              from={stroke[step - 1] ?? at}
              to={at}
              color={theme.colors.text}
            />
          )),
        )}
      </View>
      <Button theme={theme} label={clearLabel} onPress={clear} />
    </View>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

function Button(props: {
  theme: Theme;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): ReactNode {
  const { theme } = props;
  const disabled = props.disabled ?? false;
  return (
    <Pressable
      role="button"
      disabled={disabled}
      aria-disabled={disabled}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderColor: props.primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: props.primary ? theme.colors.accent : "transparent",
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        alignSelf: "flex-start",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: props.primary ? theme.colors.onAccent : theme.colors.text }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export interface ConsentScreenProps {
  /** The translator this screen renders through. Absent, the provider's, and with none, {@link EN}. */
  readonly t?: Translator;
  /** Where the consent routes are, and the fetch to reach them with. Injected so a test never reaches a Worker. */
  readonly client?: ConsentClientOptions;
}

/** A refusal carried as the read's failure, so the last answer survives it. */
class Refused extends Error {
  constructor(readonly refusal: { code: string; message: string }) {
    super(refusal.code);
  }
}

/**
 * The consent settings screen: every purpose and where the reader stands. A click-level purpose is granted here; a
 * grant is withdrawn here the way it was given, except one signed with a provider, which is withdrawn there.
 */
export function ConsentScreen({ client: options, t: given }: ConsentScreenProps): ReactNode {
  const baked = useTranslator(EN);
  const t = given ?? baked;
  const theme = useTheme();
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
          ? { method: "drawn" as const, drawn: { image: drawn, type: "image/svg+xml" as const } }
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

  const body = [theme.type.body, { color: theme.colors.text }];
  const muted = [theme.type.body, { color: theme.colors.muted }];

  if (me === null && failure === null) return <Text style={muted}>{t.t("consent/settings.loading")}</Text>;

  return (
    <View
      role="main"
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {me === null ? t.t("consent/settings.unreadable") : t.t("consent/settings.title")}
      </Text>
      {failure && <Text style={muted}>{refusalText(t, failure)}</Text>}
      {me !== null && me.purposes.length === 0 && <Text style={muted}>{t.t("consent/settings.none")}</Text>}
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
          <View key={row.purpose.id} testID={`consent-${row.purpose.id}`} style={{ gap: theme.spacing.sm }}>
            <Text style={body}>
              <Text style={{ fontWeight: "700" }}>{row.purpose.summary}</Text>{" "}
              <Text style={{ color: theme.colors.muted }}>{standingText(t, row)}</Text>
            </Text>
            {row.granted && withdrawal === "provider" ? (
              <Text style={muted}>{t.t("consent/settings.signed_with_provider")}</Text>
            ) : row.granted ? (
              <>
                {withdrawal === "typed" && (
                  <View style={{ gap: theme.spacing.xs }}>
                    <Text style={body}>{t.t("consent/settings.type_name")}</Text>
                    <TextInput
                      aria-label={t.t("consent/settings.type_name")}
                      autoComplete="name"
                      textContentType="name"
                      value={names[row.purpose.id] ?? ""}
                      onChangeText={(text) => setNames({ ...names, [row.purpose.id]: text })}
                      style={[
                        theme.type.body,
                        {
                          color: theme.colors.text,
                          backgroundColor: theme.colors.surface,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          borderRadius: theme.radius,
                          paddingVertical: theme.spacing.sm,
                          paddingHorizontal: theme.spacing.md,
                        },
                      ]}
                    />
                  </View>
                )}
                {withdrawal === "drawn" && (
                  <SignaturePad
                    label={t.t("consent/settings.draw_name")}
                    clearLabel={t.t("consent/settings.clear")}
                    onChange={(image) => setDrawings((current) => ({ ...current, [row.purpose.id]: image }))}
                  />
                )}
                <Button
                  theme={theme}
                  label={t.t("consent/settings.withdraw")}
                  disabled={busy !== null || !ready}
                  onPress={() => void choose(row, false)}
                />
              </>
            ) : clickable ? (
              <Button
                theme={theme}
                primary
                label={t.t("consent/settings.agree")}
                disabled={busy !== null}
                onPress={() => void choose(row, true)}
              />
            ) : (
              <Text style={muted}>{t.t("consent/settings.signed_elsewhere")}</Text>
            )}
          </View>
        );
      })}
      {saved && <Text style={muted}>{t.t("consent/settings.saved")}</Text>}
    </View>
  );
}

export default function Consent(): ReactNode {
  return <ConsentScreen client={consentTransport()} />;
}
