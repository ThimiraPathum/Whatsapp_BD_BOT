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
      if (name === './message-layout') return require('../src/message-layout');
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
    './database': db, fs: { existsSync: () => false },
  });
  const { createManager } = load('src/reliability.js', {
    './scheduler': scheduler, 'node-cron': {}, fs: { existsSync: () => false },
  });
  return { jobs,
    startScheduler(sock, mainGroupId) {
      const manager = createManager({ db, getSocket: () => sock, mainGroupId, repGroupId: 'rep',
        timers: { setTimeout() { return {}; }, clearTimeout() {} }, scheduler: {}, clock: () => new Date() });
      jobs.set('0 0 * * *', () => manager.dispatchTodaysPosts());
      return manager;
    },
    startDailyPreview(sock, repGroupId) { jobs.set('0 21 * * *', () => scheduler.sendDailyPreview(sock, repGroupId)); }
  };
}

test('application routing preserves Rep commands, upload approval, reaction permissions and private health', async () => {
  const db = createDb();
  const sent = [], routes = new Map(), approved = [], dispatched = [];
  let callbacks;
  const socket = { readMessages: async () => {}, sendMessage: async (chat, content) => {
    const result = { key: { id: `app-${sent.length}` } };
    sent.push({ chat, content, result }); return result;
  } };
  const app = { use() {}, get(route, fn) { routes.set(route, fn); }, post() {}, listen() {} };
  const express = Object.assign(() => app, { json: () => () => {} });
  const manager = { start() {}, check: async () => {}, health: () => ({ activeJobs: 3 }),
    dispatchTodaysPosts: async date => { dispatched.push(date); return 0; },
    sendPost: async id => { approved.push(id); db.markCompleted(id); return true; } };
  const deps = {
    './src/rep-messages': repMessages, './src/message-layout': require('../src/message-layout'),
    dotenv: { config() {} }, './src/safe-logging': { protectSessionLogs() {} },
    '@whiskeysockets/baileys': { DisconnectReason: { loggedOut: 401 }, downloadMediaMessage: async () => Buffer.from('fake') },
    '@hapi/boom': {}, 'qrcode-terminal': {}, fs: { existsSync: () => true, writeFileSync() {} }, path,
    pino: () => ({}), './src/database': db, './src/reliability': { createManager: () => manager },
    './src/connection-manager': { createConnectionManager: options => {
      callbacks = options; return { getSocket: () => socket, start: () => options.onReady(socket) };
    } },
    './src/commands': load('src/commands.js', { './database': db, fs: {} }),
    './src/vision': {}, express
  };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), {
      module: { exports: {} }, __dirname: path.resolve(__dirname, '..'), Buffer, Date, global: {},
      require: name => { if (!(name in deps)) throw Error(`Unexpected application dependency ${name}`); return deps[name]; },
      process: { env: { GROQ_API_KEY: 'test', REP_GROUP_ID: 'rep', MAIN_GROUP_ID: 'main', TIMEZONE: 'Asia/Colombo', HEALTH_TOKEN: 'test-token' }, on() {}, once() {}, exit() { throw Error('Unexpected exit'); } },
      console: { log() {}, error() {}, warn() {} }, setTimeout
    });
    const message = (chat, text, extra = {}, fromMe = false) => callbacks.onMessage(socket, { type: 'notify', messages: [{
      key: { remoteJid: chat, fromMe, id: 'incoming' }, message: { conversation: text, ...extra }
    }] });
    for (const chat of ['main', 'stranger']) await message(chat, '/pause');
    await message('rep', '/pause', {}, true);
    assert.equal(Boolean(db.isBotPaused()), false); assert.equal(sent.length, 0);
    await message('rep', '/pause'); assert.equal(db.isBotPaused(), true);
    await message('rep', '/resume'); assert.equal(db.isBotPaused(), false);
    for (const command of ['/help', '/list', '/status', '/tonight']) {
      const before = sent.length; await message('rep', command); assert.ok(sent.length > before, command);
    }
    await message('rep', '/dispatch'); assert.equal(dispatched.length, 1);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    await message('rep', `/add Test Person | ${today}`, { imageMessage: {} });
    const loading = sent.find(s => /පෝස්ටුව ඇතුළත් කරමින් පවතී/.test(s.content.text));
    const reaction = { reactionMessage: { key: loading.result.key, text: '👍' } };
    await message('main', '', reaction); await message('stranger', '', reaction);
    await message('rep', '', reaction, true); assert.equal(approved.length, 0);
    await message('rep', '', reaction); assert.equal(approved.length, 1);
    await message('rep', '', reaction); assert.equal(approved.length, 1);
    let status, body;
    const response = { sendStatus: code => { status = code; }, json: value => { body = value; } };
    routes.get('/health')({ headers: {} }, response); assert.equal(status, 401); assert.equal(body, undefined);
    routes.get('/health')({ headers: { authorization: 'Bearer test-token' } }, response); assert.equal(body.activeJobs, 3);
  } finally { db.getDb().close(); }
});

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
    assert.match(sent.at(-1), /අවශ්‍ය කරන ෆ්ලයර්/);
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
