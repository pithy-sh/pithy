// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";

/**
 * The kit-authored email copy, in Spanish.
 *
 * **Beside the English rather than in `@pithy-sh/i18n`, and that is the point of #442.** The send
 * Workflow runs in its own Worker, deployed by `pithy email provision` with no request and no access
 * to the adopter's config — so anything it does not *bundle* has to be stamped into it as a variable.
 * Held in the translations package, the kit's own Spanish was static data traveling through a
 * configuration channel every provision run, against a 5 KB per-variable ceiling. Held here, the host
 * is built with it and the variable carries only what an adopter changed, which is usually nothing.
 *
 * It also puts this file where the domain rule already says it belongs: a capability may only declare
 * keys under its own name, and `@pithy-sh/email` contributes `email/` in every language it has rather
 * than English alone. `@pithy-sh/i18n` never imports a capability and no capability imports it —
 * principle 4 holds in both directions, which a dependency edge for this data would have broken.
 *
 * Only the seven templates whose words the kit writes — `magicLink`, `otp`, `welcome`,
 * `securityAlert`, `invite`, `passwordChanged`, `leadCapture` — plus the shell: the severity labels
 * and the footer's unsubscribe link.
 *
 * The five templates whose words arrive as payload (`testerNudge`, `supportReply`,
 * `operationalNotice`, `newsletter`, `marketingCampaign`) are the adopter's copy and are not here.
 * **The shell follows the job's locale; a payload-carrying template is only as localized as the
 * adopter's own copy** — a job at locale `es` renders the severity word from this catalog and the
 * summary from the adopter's payload. That is the right behavior and it is a surprise unless stated,
 * so `docs/I18N.md` states both halves.
 */
export const EMAIL_ES: MessageCatalog = {
  // --- The shared shell ---
  // Two greetings, because Spanish addresses an unnamed reader differently rather than with the name
  // removed — the case that made a single string with an optional placeholder the wrong shape.
  "email/shell.greeting": "Hola:",
  "email/shell.greeting_named": "Hola {name}:",
  "email/shell.unsubscribe": "Cancelar la suscripción",

  // --- Severity: the word first, the color second ---
  // "Requiere acción" rather than "Advertencia" for the same reason the English says "Action needed"
  // and not "Warning": the label names what the message wants from the reader, not how loudly it is
  // being said.
  "email/severity.info": "Aviso",
  "email/severity.warning": "Requiere acción",
  "email/severity.critical": "Crítico",

  // --- magicLink ---
  "email/magic_link.subject": "Tu enlace de acceso",
  "email/magic_link.heading": "Iniciar sesión",
  "email/magic_link.instruction": "usa el botón de abajo para iniciar sesión.",
  "email/magic_link.expiry.one": "Caduca en {count} minuto.",
  "email/magic_link.expiry.other": "Caduca en {count} minutos.",
  "email/magic_link.cta": "Iniciar sesión",
  "email/magic_link.ignore": "Si no lo solicitaste, puedes ignorar este correo.",
  "email/magic_link.text_instruction.one": "Usa este enlace para iniciar sesión (caduca en {count} minuto):",
  "email/magic_link.text_instruction.other": "Usa este enlace para iniciar sesión (caduca en {count} minutos):",
  "email/magic_link.text_ignore": "Si no lo solicitaste, ignora este correo.",

  // --- otp ---
  "email/otp.subject": "Tu código de verificación",
  "email/otp.heading": "Tu código",
  "email/otp.lead": "tu código de verificación es:",
  "email/otp.expiry.one": "Caduca en {count} minuto.",
  "email/otp.expiry.other": "Caduca en {count} minutos.",
  "email/otp.text_body.one": "Tu código de verificación es {code}. Caduca en {count} minuto.",
  "email/otp.text_body.other": "Tu código de verificación es {code}. Caduca en {count} minutos.",

  // --- welcome ---
  "email/welcome.subject": "Te damos la bienvenida a {app}",
  "email/welcome.heading": "Te damos la bienvenida a {app}",
  "email/welcome.body": "Hola {name}: te damos la bienvenida a {app}. Nos alegra tenerte aquí.",
  "email/welcome.text_body": "Te damos la bienvenida a {app}. Nos alegra tenerte aquí.",

  // --- securityAlert ---
  "email/security_alert.subject": "Alerta de seguridad: {event}",
  "email/security_alert.heading": "Alerta de seguridad",
  "email/security_alert.body": "{event} el {when}.",
  "email/security_alert.ip": "Dirección IP: {ip}.",
  "email/security_alert.text_ip": "IP: {ip}.",
  "email/security_alert.reassure": "Si fuiste tú, no hace falta hacer nada.",
  "email/security_alert.cta": "Revisar la actividad",
  "email/security_alert.text_action": "Si no fuiste tú, protege tu cuenta:",

  // --- invite ---
  "email/invite.subject": "{inviter} te ha invitado a {organization}",
  "email/invite.heading": "Tienes una invitación",
  "email/invite.body": "{inviter} te ha invitado a unirte a {organization} en {app}.",
  "email/invite.cta": "Aceptar la invitación",
  "email/invite.text_accept": "Aceptar:",

  // --- passwordChanged ---
  "email/password_changed.subject": "Tu contraseña ha cambiado",
  "email/password_changed.heading": "Tu contraseña ha cambiado",
  "email/password_changed.body": "las credenciales de tu cuenta cambiaron el {when}.",
  "email/password_changed.warn": "Si no fuiste tú, contacta con soporte de inmediato.",
  "email/password_changed.cta": "Contactar con soporte",
  "email/password_changed.text_body":
    "Las credenciales de tu cuenta cambiaron el {when}. Si no fuiste tú, contacta con soporte:",

  // --- leadCapture ---
  "email/lead_capture.subject": "Tu descarga: {asset}",
  "email/lead_capture.heading": "Tu descarga está lista",
  "email/lead_capture.ready": "Tu copia de {asset} ya está lista.",
  "email/lead_capture.cta": "Descargar ahora",
  "email/lead_capture.text_ready": "Tu copia de {asset} ya está lista:",
};
