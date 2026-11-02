'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendRepMessage } = require('../src/rep-messages');
const { card, formatDate, postDetails } = require('../src/message-layout');

test('Sinhala layout preserves dates, IDs, instructions and mixed-case labels', () => {
  const text = card('🎂 උපන්දින පෝස්ටුව සූදානම්', postDetails('Kasun', '2026-10-10', 18), 'ඉවත් කිරීමට: `/cancel 18`');
  assert.match(text, /^\*🎂  උපන්දින පෝස්ටුව සූදානම්\*\n━━━━━━━━━━━━\n\n/);
  assert.match(text, /10 Oct 2026/);
  assert.match(text, /#18/);
  assert.match(text, /`\/cancel 18`/);
  assert.match(card('🌙 පෙරදැකීම (Preview)'), /\(Preview\)/);
  assert.doesNotMatch(text, /💬/);
  assert.equal(formatDate('2026-02-30'), '2026-02-30'); // Do not display a rolled-over date.
});

test('loading, success and error messages are sent without added footers', async () => {
  const sent = [];
  const sock = { sendMessage: async (chat, content) => sent.push(content) };
  for (const text of [card('🔍 ෆ්ලයර් එක පරීක්ෂා කෙරේ', 'නම සහ උපන්දිනය කියවමින් පවතී…'),
    card('🎂 උපන්දින පෝස්ටුව සූදානම්', 'ඉවත් කිරීමට: `/cancel 18`'),
    card('⚠️ ෆ්ලයර් එක කියවාගත නොහැක', '*ඊළඟ පියවර*\n`/add Kasun Perera | 2026-10-20`')]) {
    await sendRepMessage(sock, 'rep', { text });
    assert.equal(sent.at(-1).text, text);
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
    const content = { text: '▶️ Bot නැවත ක්‍රියාත්මකයි', edit };
    assert.equal(await sendRepMessage(sock, 'rep', content, options), response);
    assert.equal(sent[0][1].text, content.text);
    assert.equal(sent[0][1].edit, edit);
    assert.equal(sent[0][2], options);
    assert.equal(content.text, '▶️ Bot නැවත ක්‍රියාත්මකයි');
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
