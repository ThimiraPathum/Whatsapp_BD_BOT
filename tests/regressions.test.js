'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const repMessages = require('../src/rep-messages');

// Load production modules with isolated dependencies, never the live database,
// WhatsApp connection, filesystem writes or AI service.
function load(relativePath, dependencies) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    __dirname: path.dirname(filename),
    require(name) {
      if (name === './rep-messages') return repMessages;
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { TIMEZONE: 'Asia/Colombo', GROQ_API_KEY: 'test' } },
    console: { log() {}, warn() {}, error() {} },
    Buffer,
    Date,
    setTimeout: (callback) => callback(),
  }, { filename });
  return module.exports;
}

function createDb(connection) {
  return load('src/database.js', {
    'better-sqlite3': function () { return connection || new Database(':memory:'); },
    path,
    fs: { existsSync: () => true },
  });
}

function createScheduler(db) {
  const jobs = new Map();
  const scheduler = load('src/scheduler.js', {
    './database': db,
    fs: { existsSync: () => false },
    'node-cron': { schedule(expression, callback) {
      jobs.set(expression, callback);
      return { start() {} };
    } },
  });
  return { ...scheduler, jobs };
}

test('manual /dispatch sends the same date shown by /tonight; cron still sends today', async () => {
  const db = createDb();
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    const insert = (name, birthday) => db.insertPost({ name, birthday, imagePath: 'text-mode', msgId: name, chatId: 'rep' });
    const todayId = insert('Today Person', today);
    const tomorrowId = insert('Tomorrow Person', tomorrow);
    const sent = [];
    const sock = { async sendMessage(chat, content) {
      sent.push({ chat, content });
      return { key: { id: String(sent.length) } };
    } };
    const scheduler = createScheduler(db);
    const dispatch = scheduler.startScheduler(sock, 'main').dispatchTodaysPosts;
    const { handleCommand } = load('src/commands.js', { './database': db, fs: {} });
    await handleCommand(sock, 'rep', '/tonight', dispatch);
    assert.match(sent.at(-1).content.text, /Tomorrow Person/);
    await handleCommand(sock, 'rep', '/dispatch', dispatch);
    assert.equal(db.getPostById(tomorrowId).status, 'completed');
    assert.equal(db.getPostById(todayId).status, 'pending');
    assert.equal(sent.filter(m => m.chat === 'main').length, 1);
    await scheduler.jobs.get('0 0 * * *')();
    assert.equal(db.getPostById(todayId).status, 'completed');
  } finally { db.getDb().close(); }
});

test('a form arriving after its flyer is auto-designed; preview warns only for unfinished designs', async () => {
  const db = createDb();
  try {
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    db.insertPost({ name: 'Designed Person', birthday: tomorrow, imagePath: 'text-mode', msgId: '1', chatId: 'rep' });
    db.insertFormSubmission({ name: 'Designed Person', birthday: tomorrow, photoUrl: 'https://example.com/a' });
    db.insertFormSubmission({ name: 'Unfinished Person', birthday: tomorrow, photoUrl: 'https://example.com/b' });
    const sent = [];
    const sock = { async sendMessage(chat, content) { sent.push(content.text); } };
    assert.equal(db.getDb().prepare('SELECT status FROM form_submissions WHERE name = ?').get('Designed Person').status, 'designed');
    const scheduler = createScheduler(db);
    scheduler.startDailyPreview(sock, 'rep');
    await scheduler.jobs.get('0 21 * * *')();
    assert.match(sent.at(-1), /UNFINISHED DESIGNS DETECTED/);
    assert.match(sent.at(-1), /Unfinished Person/);
    assert.doesNotMatch(sent.at(-1), /Designed Person/);
  } finally { db.getDb().close(); }
});

test('flyer arrival, duplicate form sync and database initialization repair pending designs automatically', () => {
  const db = createDb();
  const connection = db.getDb();
  try {
    const birthday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    const form = { name: 'Kasun Perera', birthday, photoUrl: 'https://example.com/photo' };
    const id = db.insertFormSubmission(form);
    const otherId = db.insertFormSubmission({ ...form, name: 'Other Person' });
    const differentDateId = db.insertFormSubmission({ ...form, birthday: '2099-01-01' });
    const status = (formId) => connection.prepare('SELECT status FROM form_submissions WHERE id = ?').get(formId).status;
    assert.equal(status(id), 'pending_design');
    db.insertPost({ name: 'Kasun Perera', birthday, imagePath: 'test.jpg', msgId: 'test', chatId: 'rep' });
    assert.equal(status(id), 'designed');
    assert.equal(status(otherId), 'pending_design');
    assert.equal(status(differentDateId), 'pending_design');

    connection.prepare("UPDATE form_submissions SET status = 'pending_design' WHERE id = ?").run(id);
    assert.equal(db.insertFormSubmission(form), id);
    assert.equal(status(id), 'designed');
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM form_submissions').get().count, 3);

    connection.prepare("UPDATE form_submissions SET status = 'pending_design' WHERE id = ?").run(id);
    createDb(connection).getDb(); // Simulate reopening an existing database.
    assert.equal(status(id), 'designed');
    assert.equal(status(otherId), 'pending_design');
  } finally { connection.close(); }
});

async function analyze(response) {
  const vision = load('src/vision.js', {
    fs: { readFileSync: () => Buffer.from('test-image') },
    'groq-sdk': { Groq: class {
      chat = { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }) } };
    } },
  });
  return vision.extractBirthdayDetails('unused.jpg');
}

test('raw photographs preserve IGNORE without requiring birthday fields', async () => {
  const result = await analyze({ status: 'IGNORE' });
  assert.equal(result.status, 'IGNORE');
  assert.equal(result.name, undefined);
});

test('valid flyers preserve OK and trimmed fields', async () => {
  const result = await analyze({ status: 'OK', name: ' Kasun ', birthday: ' 2026-10-18 ' });
  assert.equal(result.status, 'OK');
  assert.equal(result.name, 'Kasun');
  assert.equal(result.birthday, '2026-10-18');
});

test('malformed or unsupported AI responses are rejected', async () => {
  for (const response of [null, {}, { status: 'OTHER', name: 'Kasun', birthday: '2026-10-18' },
    { status: 'OK', name: ' ', birthday: '2026-10-18' }, { status: 'OK', name: 42, birthday: '2026-10-18' }]) {
    assert.equal(await analyze(response), null);
  }
});
