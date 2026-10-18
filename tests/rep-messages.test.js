'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDailyFun, sendRepMessage } = require('../src/rep-messages');
const { card, formatDate, postDetails } = require('../src/message-layout');

test('original instructions stay intact; footer changes only at Sri Lanka midnight', () => {
  const text = card('🎂 Birthday confirmed', postDetails('Kasun', '2026-10-10', 18), 'Cancel: `/cancel 18`');
  const before = withDailyFun(text, new Date('2026-10-07T18:29:59Z'));
  const sameDay = withDailyFun(text, new Date('2026-10-06T18:30:00Z'));
  const after = withDailyFun(text, new Date('2026-10-07T18:30:00Z'));
  assert.ok(before.startsWith(text + '\n\n'));
  assert.match(before, /10 Oct 2026/);
  assert.match(before, /#18/);
  assert.match(before, /`\/cancel 18`/);
  assert.match(before, /\n\n💬 [^\n]+$/);
  assert.equal(formatDate('2026-02-30'), '2026-02-30'); // Do not display a rolled-over date.
  assert.equal(before, sameDay);
  assert.notEqual(before, after);
  assert.match(after, /boss|bro|my guy/i);
});

test('reading failures and recovery instructions have no funny footer', () => {
  for (const text of ['⚠️ FLYER NOT READ\nUpload again: /add Name | Date',
    'CRITICAL ERROR', 'Could not download the image', '⚠️ Invalid ID!',
    'Bot is currently PAUSED.', 'Immediate dispatch failed.',
    card('⚠️ Could not read flyer', 'Upload again: `/add Name | YYYY-MM-DD`'),
    card('🔎 Post not found', 'Check `/list`.'), card('🧹 Form entries cleared', 'Sync again.')]) {
    assert.equal(withDailyFun(text), text);
  }
});

test('Rep text edits keep metadata; Main Group messages and media remain untouched', async () => {
  const originalRepId = process.env.REP_GROUP_ID;
  process.env.REP_GROUP_ID = ' rep ';
  try {
    const sent = [];
    const response = { key: { id: 'sent' } };
    const sock = { async sendMessage(...args) { sent.push(args); return response; } };
    const edit = { id: 'original' };
    const options = { quoted: { key: { id: 'upload' } } };
    const content = { text: 'BOT RESUMED', edit };
    assert.equal(await sendRepMessage(sock, 'rep', content, options), response);
    assert.ok(sent[0][1].text.startsWith(content.text + '\n\n'));
    assert.equal(sent[0][1].edit, edit);
    assert.equal(sent[0][2], options);
    assert.equal(content.text, 'BOT RESUMED');
    for (const [chat, payload] of [['main', { text: 'Happy Birthday!' }],
      ['other', { text: 'Group ID' }], ['rep', { image: Buffer.from('image'), caption: 'Happy Birthday!' }]]) {
      await sendRepMessage(sock, chat, payload);
      assert.equal(sent.at(-1)[1], payload);
    }
  } finally {
    if (originalRepId === undefined) delete process.env.REP_GROUP_ID;
    else process.env.REP_GROUP_ID = originalRepId;
  }
});
