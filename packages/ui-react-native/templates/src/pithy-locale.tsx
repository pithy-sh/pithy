import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { nativeLocaleEnvironment } from "@pithy-sh/i18n/src/native/environment";
import { TranslatorProvider, useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useNegotiatedLocale } from "@pithy-sh/i18n/src/react/useNegotiatedLocale";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Text, View } from "react-native";
import { i18nProjection } from "./pithy-config";
import { onDevice } from "./platform";
import { useTheme } from "./theme";

/**
 * The language the app is in, negotiated once and rendered by every screen under it.
 *
 * On a phone the starting point is the device's own languages, through `expo-localization`, and the app follows a
 * change while it runs; a choice is remembered in AsyncStorage, since a language is not a secret. Direction goes
 * through `I18nManager`, which React Native applies only after a reload, so when the language in force lays out
 * the other way the app says so rather than flip half a layout. On the web it is the browser's languages and the
 * document's `lang` and `dir`, exactly as the React screens negotiate.
 *
 * With no i18n capability composed it renders its children untouched, and every screen reads the English it was
 * scaffolded with.
 */

/** Which platform's signals and memory the negotiation uses. A module constant: the hook needs the same one every render. */
const environment = onDevice() ? nativeLocaleEnvironment : undefined;

/** The language in force and how to choose another, for a language picker of your own. */
export interface LocaleChoice {
  /** The catalog locale in force. */
  readonly locale: string;
  /** Choose a language the project supports. Remembered on this device. */
  readonly choose: (locale: string) => void;
}

const LocaleChoiceContext = createContext<LocaleChoice>({ locale: "en", choose: () => undefined });

/** The language in force and how to choose another. */
export function useLocaleChoice(): LocaleChoice {
  return useContext(LocaleChoiceContext);
}

/** What {@link PithyLocale} takes: the app, and your own catalogs if you have any. */
export interface PithyLocaleProps {
  readonly children: ReactNode;
  /**
   * Your own catalogs, keyed by locale: the top layer, above the kit's translation and each screen's English. A
   * sentence you want said differently goes here, and so do the words for a language the kit writes nothing in.
   */
  readonly messages?: Readonly<Record<string, MessageCatalog | undefined>>;
}

const EN = {
  "app/locale.reload_required": "Restart the app to finish changing the language.",
} satisfies MessageCatalog;

/** The line a reader sees when the language in force needs a restart to lay out the right way round. */
function ReloadNotice(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  return (
    <View
      role="alert"
      style={{
        padding: theme.spacing.md,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Text style={[theme.type.caption, { color: theme.colors.text }]}>{t.t("app/locale.reload_required")}</Text>
    </View>
  );
}

/** Mount the negotiated locale over the app. Until the catalog lands, screens render their own English. */
export function PithyLocale({ children, messages }: PithyLocaleProps): ReactNode {
  const negotiated = useNegotiatedLocale(i18nProjection, { messages, environment });
  const choice = useMemo(
    () => ({ locale: negotiated.locale, choose: negotiated.choose }),
    [negotiated.locale, negotiated.choose],
  );
  const body = (
    <LocaleChoiceContext value={choice}>
      {negotiated.reloadRequired ? <ReloadNotice /> : null}
      {children}
    </LocaleChoiceContext>
  );
  if (negotiated.source === null) return body;
  return <TranslatorProvider value={negotiated.source}>{body}</TranslatorProvider>;
}
