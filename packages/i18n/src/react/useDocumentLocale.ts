// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { applyDocumentLocale } from "../browser/signals";

/**
 * Keep `lang` and `dir` on the document in step with the locale in force.
 *
 * `enabled` false writes nothing: a project without the capability keeps the `lang` its `index.html` shipped,
 * because restamping the document with a locale no chain chose would declare a language nothing negotiated.
 */
export function useDocumentLocale(enabled: boolean, locale: string, direction: "ltr" | "rtl"): void {
  useEffect(() => {
    if (!enabled) return;
    applyDocumentLocale(locale, direction);
  }, [enabled, locale, direction]);
}
