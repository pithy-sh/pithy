// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";

/**
 * The kit's screens, in Spanish — every string `@pithy-sh/ui-react` renders.
 *
 * The English twin of this catalog is not here and is not in this package: it is baked into each
 * template, because a template is **copied** into the adopter's repository and its own English is the
 * only catalog that survives the copy. That is what makes a project which never composes `i18n` render
 * byte for byte as it did before, with no dependency on this package at all.
 *
 * **The keys are the join, and they are the templates'.** A key here that no template renders is a
 * sentence nobody will ever read; a template key missing here is a Spanish reader meeting English. Both
 * are invisible to `tsc` — a `MessageCatalog` is `Record<string, string>` and every typo satisfies it —
 * so the way to check a change is to read the template beside it.
 *
 * **Two invariants are per-locale and survive translation, so they are checked here rather than only in
 * English.** `auth/sign_in.provider.label` is the provider buttons' accessible name and must **contain**
 * the visible word, which is the brand name and is never translated — voice control matches what a
 * reader can see (WCAG 2.5.3, Label in Name). And nothing a sign-in button says may name a code: the
 * screen offers one way in, the link, and `código` on that screen is a second passwordless path being
 * advertised by a translation. The word appears here only under `auth/otp.*`, which is a different
 * screen and the one place it is right.
 *
 * **Neutral where English is neutral.** English `You're subscribed.` carries no gender and
 * `Estás suscrito.` does, so the Spanish says what the subscription is doing rather than what the
 * reader is. The same argument moves `Welcome.` off `Bienvenido.`.
 */
export const esScreens: MessageCatalog = {
  // ── auth: the sign-in screen ───────────────────────────────────────────────
  "auth/sign_in.title": "Te damos la bienvenida.",
  "auth/sign_in.provider.label": "Continuar con {provider}",
  "auth/sign_in.provider_unconfigured": "{provider} no está configurado aquí. Usa el enlace.",
  "auth/sign_in.provider_silent": "{provider} no respondió. Usa el enlace.",
  "auth/sign_in.divider": "o",
  "auth/sign_in.email.label": "Correo electrónico",
  "auth/sign_in.submit": "Envíame un enlace",
  "auth/sign_in.signup.prompt": "¿Aún no tienes cuenta?",
  "auth/sign_in.signup.answer": "Al entrar se crea una.",
  "auth/sign_in.signup.closed": "Solo cuentas existentes.",
  "auth/sign_in.sent.title": "Mira tu correo.",
  "auth/sign_in.sent.body": "Si esa dirección puede entrar, el enlace ya va en camino. Caduca pronto.",

  // ── auth: the one-time code screen ─────────────────────────────────────────
  "auth/otp.title": "Introduce el código.",
  "auth/otp.sent.one": "Hemos enviado {count} dígito a {email}.",
  "auth/otp.sent.other": "Hemos enviado {count} dígitos a {email}.",
  "auth/otp.inbox": "tu correo",
  "auth/otp.failed": "Ese código no funcionó. Inténtalo otra vez o pide uno nuevo.",
  "auth/otp.submit": "Entrar",
  "auth/otp.resend": "Enviar un código nuevo",

  // ── auth: the magic link's landing screen ──────────────────────────────────
  "auth/callback.title": "Entrando.",
  "auth/callback.body": "Un momento.",

  // ── payments: the paywall ──────────────────────────────────────────────────
  "payments/paywall.title": "Ve más lejos.",
  "payments/paywall.body": "Elige lo que necesitas. Puedes cambiar de idea más tarde.",
  "payments/paywall.buy": "Comprar {product}",
  "payments/paywall.in_app": "Disponible en la app.",
  "payments/paywall.holdings": "¿Qué tengo ya?",
  "payments/paywall.empty.title": "Nada a la venta.",
  // The sentence continues into a `<code>pithy.config.ts</code>` the screen renders after it. A file
  // name is not copy, so it is not a placeholder here and no translation may move it.
  "payments/paywall.empty.body": "Este proyecto aún no tiene catálogo. Añade productos en",
  "payments/paywall.done.title": "Todo listo.",
  "payments/paywall.done.body": "Gracias. Tu compra ya está en tu cuenta.",
  "payments/paywall.done.home": "Ir al inicio",

  // ── payments: the pricing screen ───────────────────────────────────────────
  "payments/pricing.title": "Lo que cuesta.",
  "payments/pricing.body": "Los precios son para donde estás. Los impuestos los calcula Paddle, no nosotros.",
  "payments/pricing.anonymous": "Cualquiera puede ver un precio. Comprar necesita cuenta.",
  "payments/pricing.loading": "Buscando tu precio.",
  "payments/pricing.estimated": "Estimado.",
  "payments/pricing.unavailable": "No pudimos obtener un precio. Lo verás al pagar.",
  "payments/pricing.sign_in": "Entra para comprar {product}",
  "payments/pricing.buy": "Comprar {product}",
  "payments/pricing.holdings": "¿Qué tengo ya?",
  // `{interval}` is Paddle's own word for the billing period and arrives from their API in English, so
  // it is left where it lands rather than half-translated into a sentence that then disagrees with the
  // figure beside it. An adopter who wants `al mes` says so in `i18n({ messages })`.
  "payments/pricing.every.one": "al {interval}",
  "payments/pricing.every.other": "cada {count} {interval}s",
  "payments/pricing.empty.title": "Aquí no hay precios.",
  // Two halves of one sentence, with `<code>paddle</code>` between them and `<code>pithy.config.ts</code>`
  // after. Both code words are identifiers and neither is translated.
  "payments/pricing.empty.body": "Esta pantalla pone precio a lo que vendes por Paddle. Añade un bloque",
  "payments/pricing.empty.body_end": "a un producto en",

  // ── payments: what the reader already holds ────────────────────────────────
  "payments/subscription.subscribed": "Tu suscripción está activa.",
  "payments/subscription.empty": "Aún nada.",
  "payments/subscription.unreadable": "No pudimos comprobarlo.",
  "payments/subscription.nothing_held": "No tienes nada en esta cuenta.",
  "payments/subscription.loading": "Un momento.",
  "payments/subscription.holding.ended": "Finalizado.",
  "payments/subscription.holding.ended_not_renewing": "Finalizado, y no se renueva.",
  "payments/subscription.holding.kept": "Tuyo para siempre.",
  // The date itself is `Intl`'s, rendered from the reader's formatting locale. This is the sentence
  // around it, which is the only part a catalog can own.
  "payments/subscription.holding.renews": "Se renueva el {date}.",
  "payments/subscription.manage": "Gestionar la facturación",
  "payments/subscription.apple": "Comprado en la App Store",
  "payments/subscription.google": "Comprado en Google Play",
  "payments/subscription.more": "Ver qué más hay",

  // ── app: the adopter's own shell and home screen ───────────────────────────
  //
  // Under `app/` rather than a capability name because that is what these are: the router and the home
  // screen are the adopter's files, seeded once and never rewritten. Translating them here is what
  // makes a freshly scaffolded project speak Spanish on its first screen rather than its second.
  "app/loading": "Un momento.",
  "app/not_found.title": "Aquí no hay nada.",
  "app/not_found.body": "Nada responde en {path}.",
  "app/not_found.home": "Ir al inicio",
  "app/home.title": "Ya estás dentro.",
  "app/home.signed_in_as": "Has entrado como {email}.",
  "app/home.someone": "alguien",
  "app/home.sign_out": "Salir",
  "app/home.bare.title": "Funciona.",
  "app/home.bare.body": "El worker dice: {status}.",
  "app/home.bare.checking": "comprobando",
  "app/home.bare.unknown": "desconocido",
  "app/home.bare.unreachable": "inaccesible",

  // ── client: the failures a browser mints for itself, never sent by a Worker ─
  //
  // `client/*` is the one domain with no capability behind it, and that is deliberate: these are the
  // codes an SDK writes when the request never reached a Worker at all — offline, a proxy's HTML page,
  // no browser to redirect. They are also the failures a reader meets most, which is why leaving them
  // untranslated made the whole feature read as half-finished: a Spanish sign-in page answering an
  // offline phone in English is the first thing anybody would notice.
  //
  // **`@pithy-sh/auth` and `@pithy-sh/payments` mint the same two codes with different English** — "the
  // server" against "the store" — and one key holds one string. The Spanish is written to be true of
  // both rather than picking a side; the noun each English sentence names is not information the
  // reader needed, and inventing `auth/client_unreachable` to keep it would put the same failure under
  // two codes for the sake of one word.
  "client/unreachable": "No hemos podido conectar.",
  "client/unreadable": "La respuesta no se ha podido leer.",
  "client/cross_origin": "Esa petición habría salido de este sitio, así que no se ha enviado.",
  "client/no_browser": "No hay ningún navegador al que enviarte para pagar.",
};
