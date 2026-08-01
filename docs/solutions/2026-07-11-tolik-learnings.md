# Learnings — Толик overhaul (2026-07-11)

Non-obvious things that bit us; keep for next time.

## 1. Intent precedence in parseEntry: reminder must beat debt
**Bug:** «напомни мне 29 июля, что должно прийти 95к по зп» was saved as the user's DEBT and never fired on 29 July.
**Root cause:** `parseEntry()` checked the debt trigger `/долж|долг|занял|одолжил/` BEFORE the task/reminder branch, so «долж» inside «должно» routed to `parseDebt()`. And because a misclassified debt keeps `hasTime:false`, `store.dueReminders()` (needs `hasTime:true`) never fired it → looked "ignored / fired days later".
**Fix pattern:** a leading/あpresent reminder verb (`напомни(ть)|переспрос…|спроси меня|не забудь спросить`) must SHORT-CIRCUIT to a `task` before the debt branch. Also guard income phrasing (`должн[а-я]* (прийти|поступить|зачисл…)`) so "money coming to me" isn't a debt. → `src/parser.mjs`.
**Takeaway:** in a keyword router, order = priority. When one intent's keyword is a substring of another's phrasing, the more-specific intent must be tested first.

## 2. Двойное сохранение: silent capture + route both write
**Bug:** with AI disabled, one «Иванов должен 50000» text created TWO debt entries.
**Root cause:** `friendFlow` calls `captureEntry()` (silent structured capture for the AI path) and THEN, in the `!aiEnabled()` branch, calls `handleMessage()`→`route()`'s `'entry'` case which `saveEntry()`s again.
**Fix:** `captureEntry` only on the AI path (AI reply doesn't route); in no-AI mode `handleMessage` is the sole writer. Prod (AI on) never hit it — but tests run AI-off, which is exactly why AI-off paths need their own coverage. → `src/telegram.mjs`, `src/group.mjs`.

## 3. Voice parity: one routeText for text AND transcripts
**Bug:** new «личный кабинет» (LK) worked by typing but not by voice — voice «настройки» opened the OLD settings, voice answers to an LK prompt were dropped.
**Root cause:** `audioFlow` routed transcripts straight to `onboardingStep→handleIntent→friendFlow`, bypassing the `LK_TRIGGER_RE`/`lk.consumeInput` layer that only the typed `onMessage` tail had.
**Fix:** extract ONE `router.routeText(chatId, user, text)` (onboarding → LK trigger → LK pending → intents → conversation) and have `onMessage`, `audioFlow`, and the video-note branch all call it. Any new command layer added to the text path is then automatically reached by voice.
**Takeaway:** text and voice must converge to a single routing function; adding a feature only to `onMessage` silently excludes voice.

## 4. Held-out e2e for a Telegram bot (no browser)
Boot the real `startTelegramBot(store, token)` behind a spy `global.fetch` that captures outgoing method+params and feeds crafted updates back through the first `getUpdates` (pace the poll with a small real `setTimeout` to avoid microtask livelock). Assert on captured `sendMessage`/`sendPhoto` params (text + `reply_markup.inline_keyboard`). File must be named `*.e2e.holdout.*` (protection-hooked). See `test/tolik.e2e.holdout.test.mjs`.

## 5. Store reminders fire in MSK
Date-without-time reminders get noon in the user's tz (`DEFAULT_OFFSET=180`) via `normalizeReminderDue`; the scheduler needs `hasTime:true` to fire, so any reminder path that skips normalization silently won't fire. Keep captureEntry (bot) and route/saveEntry (web) both going through `normalizeReminderDue`.
