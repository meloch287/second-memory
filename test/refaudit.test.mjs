import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Регрессия: критичные внутренние функции бота должны быть ОПРЕДЕЛЕНЫ.
// Однажды при рефакторинге удалились sleepyText/withWake (валидно
// синтаксически, --check и юнит-тесты модулей это не поймали) - бот падал
// на каждом ответе. Этот тест ловит такой класс бага.

function definesAll(relPath, names) {
  const src = readFileSync(new URL(`../src/${relPath}`, import.meta.url), 'utf8');
  const missing = [];
  for (const name of names) {
    const re = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`);
    if (!re.test(src)) missing.push(name);
  }
  return missing;
}

test('telegram.mjs: критичные хелперы на месте', () => {
  const need = [
    'sleepyText', 'withWake', 'friendFlow', 'handleIntent', 'maybeOfferCalendar',
    'sendIcs', 'upcomingEvents', 'settingsText', 'sendDocumentText', 'transcribeLong',
    'audioFlow', 'imageFlow', 'onMessage', 'onCallback', 'sendVoice', 'startOnboarding',
    'onboardingStep', 'helloAgain', 'askReset', 'helpText', 'sendSummary', 'typingLoop',
    'withTyping', 'downloadBase64', 'enqueue', 'kindOf', 'locationFlow', 'askLocation', 'deliver',
    'groupFlow', 'runGroupCmd', 'mentionsBot', 'callerIsAdmin', 'ensureSelf', 'isGroupChat', 'authorName', 'stripMention',
  ];
  const missing = definesAll('telegram.mjs', need);
  assert.deepEqual(missing, [], `не определены: ${missing.join(', ')}`);
});

test('ai.mjs: экспортируемые ИИ-функции на месте', () => {
  const need = [
    'aiFriendReply', 'aiSearch', 'aiDiarySummary', 'aiFollowup', 'aiMorningPing',
    'aiExtractFacts', 'aiEmbed', 'smartRecall', 'aiConsolidate', 'aiTranscribe',
    'aiTts', 'aiDescribeImage', 'aiSummarizeDoc', 'aiSummarizeText', 'chatCompletion',
    'aiCheckin', 'aiExtractReceipt',
  ];
  const missing = definesAll('ai.mjs', need);
  assert.deepEqual(missing, [], `не определены: ${missing.join(', ')}`);
});

test('scheduler.mjs / brain.mjs: ключевые функции на месте', () => {
  assert.deepEqual(definesAll('scheduler.mjs', ['startScheduler', 'perUser', 'runTick', 'nightJobs', 'todayEvents', 'recurringDue']), []);
  assert.deepEqual(definesAll('brain.mjs', ['handleMessage', 'route', 'captureEntry', 'saveEntry', 'runQuery', 'digest', 'debtsReply', 'fmtDate']), []);
});
