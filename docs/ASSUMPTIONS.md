# Assumptions — «Толик» overnight ship (branch Tolik)

Autonomous run; ambiguities resolved as below and proceeded.

## Repo / delivery
- **No new repo.** Work stays in the existing `meloch287/second-memory` repo on branch **Tolik**
  (user explicitly created it and said "правим только бота"). `/ship` step 4 (create private repo)
  is satisfied by the existing private repo; final push is to `origin/Tolik`.
- Browser/web version is FROZEN this run — only the Telegram bot is touched. Avoid editing
  `public/*` unless strictly required; if touched, route through accessibility-lead.
- The bot's inline keyboards are Telegram UI, NOT web UI — the web accessibility edit-gate /
  WCAG review does not apply to them.

## Identity / persona (U0)
- The bot's name is ALWAYS **Толик** (default `botName = 'Толик'`). The user no longer names the
  bot. Onboarding: greet as Толик, then ask the USER's name, then rhythm, then timezone (drop the
  old "как меня назвать" step). Existing users keep their stored `botName` unless it's the old
  default "Вторая память"/empty → treated as Толик.
- Persona strings (`friendSystem`) refer to Толик.

## Summary removal (U1)
- Remove the summary/«Итог»/«саммари» command from the BOT: parser intent, brain routing, /help
  text, and the bot menu. `aiSummary`/`aiDiarySummary` code may stay exported (web could use it
  later) but is unwired from the bot's command surface.

## Reminders (U2 — the reported bug)
- ALL reminder times are in **MSK (UTC+3)** by default (user is MSK; `DEFAULT_OFFSET=180`).
- "напомни … <дата в будущем> …" → a **task reminder** due that date, fires ON that date (noon MSK
  if no time given), NOT a debt. Phrases like "должно прийти 95к по зп", "пришло по зп",
  "переспроси 29-го" are reminders/questions, NOT debts — «долг» is only real money owed
  ("Х должен", "я должен Y", "занял/одолжил").
- "напомни через 10 минут/3 дня/2 часа" → fires exactly after that interval.
- Reminder must fire once, at the right time, and re-asking must not duplicate.

## Settings / личный кабинет (U3a)
- Command `/settings` and Russian «настройки» open an inline-keyboard LK showing stats:
  requests to Толик (new per-user counter), facts remembered, open debts, open tasks/meetings,
  days since first contact. Buttons: **Фитнес** (stub — "в разработке, следующая фаза"),
  **Долги**, **Вишлист**.

## Долги (U3b)
- «Долги» → list of all debts (кто/сколько/направление/срок/статус). Inline buttons to add /
  edit / delete each; add also by voice/text to Толик. Deletions/edits persist and Толик "remembers".

## Вишлист (U3c — hardest)
- New store collection `wishlist` per chat: {id, title, desc, url, photos[], price?, giftedBy?}.
- «Вишлист» → list; «+» asks: **по ссылке (авто)** or **вручную**. Manual = ask title/desc/url.
- «Посмотреть фото» → gallery: "N/M — title" + photo(s) + desc + link, inline nav `‹ | ›` and
  «Назад». The middle `|` button is a no-op (per spec).
- URL auto-parse (title/desc/photos) is BEST-EFFORT: Ozon/Я.Маркет have strong antibots
  (memory: Ozon 403s local/WebFetch; the VPS-curl trick returns a slug). If auto-parse can't get
  photos reliably, the item is still saved with URL + whatever was parsed, and manual entry is the
  guaranteed path. Auto-parse of full photo sets may land as **residual**.

## Testing
- Bot flows verified the project's existing way: spy-bot mock (`fetch`/`api` stubbed) driving
  `onMessage`/`onCallback`, plus deterministic `node --test`. No browser/Playwright for the bot
  (it has no web surface); holdout checks are `*.holdout.test.mjs` exercising the real handlers.
