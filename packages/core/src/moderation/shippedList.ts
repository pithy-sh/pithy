// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-FileCopyrightText: 2025 Joseph Liu
// SPDX-License-Identifier: MIT

/*
 * The words are taken from the English dataset of obscenity 0.4.6 (https://github.com/jo3-l/obscenity),
 * reduced to plain words and inflections in the format `blocklistModerator` reads. That dataset carries this
 * notice:
 *
 * The MIT License (MIT)
 *
 * Copyright © 2025 Joseph Liu.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

/**
 * The blocklist the default moderator checks: English slurs, sexual terms and profanity.
 *
 * Each entry is a whole word; one ending in `*` matches every word that starts with it, and one of several
 * words matches them in order or run together. A word that is a common innocent word in English or another
 * language, or the start of many, is listed exactly, never starred: `anal` rejects itself and allows
 * `analysis`.
 *
 * Extend it with `moderation.words`, or drop it with `moderation.includeShipped: false`.
 */
export const SHIPPED_BLOCKLIST: readonly string[] = [
  "abeed",
  "africoon*",
  "anal",
  "anus",
  "arabush*",
  "arse",
  "arsehole*",
  "ass",
  "asshole*",
  "bastard*",
  "bestiality",
  "bitch*",
  "blowjob*",
  "bollocks",
  "boob",
  "boobs",
  "boonga*",
  "buttplug*",
  "ching chong",
  "chink",
  "chinks",
  "cock",
  "cocks",
  "cocksucker*",
  "cuck",
  "cuckold*",
  "cumshot*",
  "cunt*",
  "deepthroat*",
  "dick",
  "dicks",
  "dickhead*",
  "dildo*",
  "doggy style",
  "double penetration",
  "dyke",
  "dykes",
  "ejaculat*",
  "fag",
  "fags",
  "faggot*",
  "felch*",
  "fellatio",
  "finger bang*",
  "fisting",
  "fuck*",
  "gangbang*",
  "handjob*",
  "hentai",
  "incest*",
  "jerk off",
  "jizz*",
  "kike",
  "kikes",
  "lubejob*",
  "masturbat*",
  "nigga*",
  "nigger*",
  "orgasm*",
  "orgy",
  "orgies",
  "penis",
  "piss",
  "porn*",
  "prick",
  "pricks",
  "pussy",
  "pussies",
  "rape",
  "raped",
  "rapist*",
  "retard",
  "retards",
  "retarded",
  "semen",
  "sex",
  "shit*",
  "slut*",
  "spastic",
  "tit",
  "tits",
  "titties",
  "tranny",
  "trannies",
  "turd",
  "turds",
  "twat*",
  "vagina",
  "wank*",
  "whore*",
];
