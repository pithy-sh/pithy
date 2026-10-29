import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { origin } from "../../pithy-config";
import { onDevice } from "../../platform";
import { useTheme } from "../../theme";

// Your screen. Pithy wrote this file once and never will again: everything under src/routes/app/ is yours. Add a
// screen by dropping a file in beside it with its own `path` export.
export const path = "/";

/** What the health route answers. Every Pithy Worker serves it. */
interface Health {
  status: string;
}

function isHealth(value: unknown): value is Health {
  return typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string";
}

/** This screen's English, baked in. `checking`, `unknown` and `unreachable` are its own words, not the Worker's. */
const EN = {
  "app/home.bare.title": "It runs.",
  "app/home.bare.body": "The worker says: {status}.",
  "app/home.bare.checking": "checking",
  "app/home.bare.unknown": "unknown",
  "app/home.bare.unreachable": "unreachable",
} satisfies MessageCatalog;

/** What the health check came back with: the Worker's own word, or one of this screen's two faults. */
type Said = { reported: string } | { fault: "unknown" | "unreachable" } | null;

/**
 * Ask the Worker how it is. The route is public and reads nothing about you, so it carries no credential. On a
 * phone it goes to the Worker's origin; the web build is served from that origin, so its path is relative.
 * `HEALTH_PATH` is the constant the Worker mounts the route from.
 */
async function checkHealth(): Promise<Said> {
  try {
    const url = onDevice() ? `${origin}${HEALTH_PATH}` : HEALTH_PATH;
    const body: unknown = await (await fetch(url)).json();
    return isHealth(body) ? { reported: body.status } : { fault: "unknown" };
  } catch {
    return { fault: "unreachable" };
  }
}

/** The word to show: the Worker's own, this screen's for a fault, or its word for still waiting. */
function said(t: Translator, health: Said): string {
  if (health === null) return t.t("app/home.bare.checking");
  return "reported" in health ? health.reported : t.t(`app/home.bare.${health.fault}`);
}

export default function Home(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const status = useRead("health", checkHealth).value ?? null;

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("app/home.bare.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {t.t("app/home.bare.body", { status: said(t, status) })}
      </Text>
    </View>
  );
}
