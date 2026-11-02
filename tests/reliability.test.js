'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const { createConnectionManager } = require('../src/connection-manager');

function harness(iso = '2026-11-02T18:30:00Z') {
  let now = new Date(iso), socket, backupCount = 0;
  const sql = new Database(':memory:');
  const rows = [], sends = [], deleted = [], intervals = new Set(), jobs = [];
  const DateFake = class extends Date { constructor(...a) { super(...(a.length ? a : [now.getTime()])); } static now() { return now.getTime(); } };
  const db = { getDb: () => sql, isBotPaused: () => db.paused, paused: false,
    getPendingForToday: date => rows.filter(p => p.birthday === date && p.status === 'pending'),
    getPostById: id => rows.find(p => p.id === id),
    markCompleted: id => db.getPostById(id).status = 'completed',
    markFailed: id => db.getPostById(id).status = 'failed',
    backupDatabase: async () => { backupCount++; } };
  sql.exec('CREATE TABLE form_submissions(name TEXT,birthday TEXT,status TEXT)');
  const fakeFs = { existsSync: file => file !== 'missing.jpg', readFileSync: () => Buffer.from('image'), unlinkSync: file => deleted.push(file) };
  const timeouts = new Map();
  const timers = { setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
    setTimeout(fn, delay) { if (delay <= 3000) { fn(); return {}; } timeouts.set(fn, delay); return fn; }, clearTimeout(fn) { timeouts.delete(fn); } };
  const cron = { schedule(expression, fn, options) { const job = Object.assign(new EventEmitter(), { expression, fn, options, active: true, destroy() { this.active = false; this.removeAllListeners(); } }); jobs.push(job); return job; } };
  function load(file, deps) {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), {
      module: mod, exports: mod.exports, require: name => { if (name in deps) return deps[name]; throw Error(name); },
      console: { log() {}, error() {}, warn() {} }, Date: DateFake, Intl, Buffer,
      process: { env: { TIMEZONE: 'Asia/Colombo' } }, setTimeout: fn => fn()
    });
    return mod.exports;
  }
  const scheduler = load('scheduler.js', { 'node-cron': cron, fs: fakeFs, './database': db,
    './message-layout': require('../src/message-layout'),
    './rep-messages': { sendRepMessage: (s,c,m,o) => s.sendMessage(c,m,o) } });
  const { createManager } = load('reliability.js', { fs: fakeFs, 'node-cron': cron, './scheduler': scheduler });
  const freshSocket = () => ({ ws: { isOpen: true }, sendMessage: async (chat, content) => { sends.push({ chat, content }); return { key: { id: `msg-${sends.length}` } }; } });
  socket = freshSocket();
  const make = (extra = {}) => createManager({ db, getSocket: () => socket, mainGroupId: 'main', repGroupId: 'rep', clock: () => now, timers, scheduler: cron, ...extra });
  let manager = make();
  const add = (options = {}) => { const row = { id: rows.length + 1, name: 'Person', birthday: '2026-11-03', created_at: '2026-11-02 10:00:00', image_path: 'flyer.jpg', status: 'pending', ...options }; rows.push(row); return row; };
  return { db, sql, rows, sends, jobs, intervals, timeouts, deleted, add, freshSocket,
    get manager() { return manager; }, get socket() { return socket; }, set socket(s) { socket = s; },
    get backups() { return backupCount; }, time: value => { now = new Date(value); },
    restart(extra) { manager.stop(); manager = make(extra); }, close() { manager.stop(); sql.close(); } };
}

test('one manager: repeated starts/reconnects retain three jobs and one timer; stop cleans up', async () => {
  const h = harness();
  try { for (let i=0;i<11;i++) { h.socket = h.freshSocket(); h.manager.start(); await h.manager.check(); }
    await h.manager.drain(); assert.equal(h.jobs.length,3); assert.equal(h.intervals.size,1);
    assert.deepEqual(h.jobs.map(j => j.expression), ['0 0 * * *', '0 21 * * *', '5 0 * * *']);
    for (const job of h.jobs) {
      assert.equal(job.options.timezone, 'Asia/Colombo'); assert.equal(job.options.noOverlap, true);
      assert.equal(job.options.missedExecutionTolerance, 60000);
    }
    h.manager.stop(); assert.equal(h.jobs.filter(j=>j.active).length,0); assert.equal(h.intervals.size,0);
  } finally { h.close(); }
});

test('missed cron event and recovery interval reconcile once without registering jobs', async () => {
  const h = harness('2026-10-31T15:29:00Z');
  try {
    h.manager.start(); await new Promise(setImmediate);
    h.time('2026-10-31T15:33:00Z');
    h.jobs.find(j => j.expression === '0 21 * * *').emit('execution:missed');
    for (const tick of h.intervals) tick();
    await new Promise(setImmediate);
    assert.equal(h.sends.length, 1); assert.equal(h.jobs.length, 3);
    assert.match(h.sends[0].content.text, /01 Nov 2026/);
  } finally { h.close(); }
});
for (const count of [0,1,3]) test(`21:00 preview exactly once with ${count} birthdays and tomorrow date`, async () => {
  const h=harness('2026-10-31T15:30:00Z');
  try { for(let i=0;i<count;i++) h.add({birthday:'2026-11-01'});
    await h.manager.check(); await h.manager.check();
    assert.equal(h.sends.length,1); assert.equal(h.sends[0].chat,'rep');
    assert.match(h.sends[0].content.text,/01 Nov 2026/);
    assert.match(h.sends[0].content.text,new RegExp(`Ready to send · ${count}`));
  } finally {h.close();}
});
test('unfinished forms still warn; successful preview is not repeated on restart', async()=>{
 const h=harness('2026-10-31T15:30:00Z'); try {
 h.sql.prepare('INSERT INTO form_submissions VALUES (?,?,?)').run('Missing','2026-11-01','pending_design');
 await h.manager.check(); assert.equal(h.sends.length,2); assert.match(h.sends[1].content.text,/Missing/);
 h.restart(); await h.manager.check(); assert.equal(h.sends.length,2);
 } finally {h.close();}
});
test('20:59 disconnect and 21:03 reconnect recover preview using newest socket', async()=>{
 const h=harness('2026-10-31T15:29:00Z'); try {
 const old=h.socket; h.socket=null; await h.manager.check(); h.time('2026-10-31T15:30:00Z'); await h.manager.check();
 assert.equal(h.sends.length,0); assert.ok(h.manager.health().alerts.length);
 old.sendMessage=()=>{throw Error('stale socket reused');}; h.socket=h.freshSocket();
 h.time('2026-10-31T15:33:00Z'); await h.manager.check(); assert.equal(h.sends.length,1);
 } finally {h.close();}
});
test('expired preview is never sent after midnight',async()=>{
 const h=harness('2026-10-31T15:30:00Z');try{h.socket=null;await h.manager.check();h.socket=h.freshSocket();h.time('2026-10-31T18:30:00Z');await h.manager.check();assert.equal(h.sends.length,0);assert.equal(h.sql.prepare("SELECT state FROM delivery_runs WHERE kind='preview'").get().state,'expired');}finally{h.close();}
});
for(const birthday of ['2026-11-01','2027-01-01']) test(`midnight and recovery across boundary ${birthday}`,async()=>{
 const h=harness(new Date(Date.parse(birthday+'T00:00:00Z')-19800000).toISOString());try{
 h.add({birthday,created_at:'2026-10-30 00:00:00'});h.socket=null;await h.manager.check();assert.equal(h.sends.length,0);
 h.socket=h.freshSocket();await h.manager.check();await h.manager.check();assert.equal(h.sends.length,1);assert.equal(h.rows[0].status,'completed');
 h.restart();await h.manager.check();assert.equal(h.sends.length,1);
 }finally{h.close();}
});
test('manual and cron concurrency use one durable claim and clean image once',async()=>{
 const h=harness();try{h.add();let release;h.socket.sendMessage=async()=>{h.sends.push({});await new Promise(r=>release=r);return {key:{id:'ack'}};};
 const a=h.manager.dispatchTodaysPosts('2026-11-03');const b=h.manager.dispatchTodaysPosts('2026-11-03');release();await Promise.all([a,b]);
 assert.equal(h.sends.length,1);assert.equal(h.deleted.length,1);
 }finally{h.close();}
});
test('ambiguous acceptance is not retried and image survives restart',async()=>{
 const h=harness();try{h.add();h.socket.sendMessage=async()=>{h.sends.push({});throw Error('timeout after acceptance');};
 await h.manager.check();h.restart();h.socket=h.freshSocket();await h.manager.check();
 assert.equal(h.sends.length,1);assert.equal(h.deleted.length,0);assert.equal(h.sql.prepare("SELECT state FROM delivery_runs WHERE kind='birthday'").get().state,'ambiguous');
 }finally{h.close();}
});
test('missing image permanent failure and paused posts are never sent',async()=>{
 const h=harness();try{h.add({image_path:'missing.jpg'});h.db.paused=true;await h.manager.check();assert.equal(h.rows[0].status,'pending');h.db.paused=false;await h.manager.check();assert.equal(h.rows[0].status,'failed');assert.equal(h.sends.length,0);assert.equal(h.deleted.length,0);}finally{h.close();}
});
test('same-day uploads retain reaction approval; expired and historical birthdays are excluded',async()=>{
 const h=harness();try{h.add({created_at:'2026-11-02 18:30:00'});h.add({birthday:'2026-11-01'});await h.manager.check();assert.equal(h.sends.length,0);
 h.add();h.time('2026-11-02T21:00:00Z');await h.manager.check();assert.equal(h.sends.length,0);
 }finally{h.close();}
});
test('Sasini historical incident exclusion blocks even explicit manual delivery',async()=>{
 const h=harness('2026-10-31T18:30:00Z');try{const p=h.add({name:'Sasini Hansika',birthday:'2026-11-01'});await h.manager.sendPost(p.id);await h.manager.check();assert.equal(h.sends.length,0);}finally{h.close();}
});
test('backup once at 00:05 and never again after restart',async()=>{
 const h=harness('2026-11-02T18:34:00Z');try{await h.manager.check();assert.equal(h.backups,0);h.time('2026-11-02T18:35:00Z');await h.manager.check();await h.manager.check();h.restart();await h.manager.check();assert.equal(h.backups,1);}finally{h.close();}
});
test('restart converts in-progress send to ambiguous rather than resending',async()=>{
 const h=harness();try{h.add();h.sql.prepare("INSERT INTO delivery_runs(key,kind,state,updated_at) VALUES ('post:1','birthday','in_progress',?)").run('2026-11-02T18:30:00Z');h.restart();await h.manager.check();assert.equal(h.sends.length,0);assert.ok(h.manager.health().alerts.length);}finally{h.close();}
});
test('connection single flight, ten reconnects, stale events, logout, cleanup',async()=>{
 const sockets=[],pending=new Map();let count=0, ready=0;
 const timers={setTimeout(fn,delay){pending.set(fn,delay);return fn;},clearTimeout(fn){pending.delete(fn);}};
 const c=createConnectionManager({timers,loggedOutCode:401,onReady:()=>ready++,onMessage:()=>{},createSocket:async()=>{count++;const s={ev:new EventEmitter(),end(){}};sockets.push(s);return{socket:s,saveCreds(){}};}});
 await Promise.all([c.start(),c.start(),c.start()]);assert.equal(count,1);
 for(let i=0;i<10;i++) {const s=sockets.at(-1);s.ev.emit('connection.update',{connection:'open'});s.ev.emit('connection.update',{connection:'open'});assert.equal(c.getSocket(),s);
 s.ev.emit('connection.update',{connection:'close'});assert.equal(c.getSocket(),null);assert.equal(s.ev.eventNames().length,0);assert.equal(pending.size,1);
 const fn=pending.keys().next().value;pending.delete(fn);fn();await c.start();s.ev.emit('connection.update',{connection:'open'});assert.notEqual(c.getSocket(),s);}
 assert.equal(count,11);assert.equal(ready,10);
 sockets.at(-1).ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});assert.equal(pending.size,0);await c.start();assert.equal(count,11);c.stop();
});

test('missing application acknowledgement remains ambiguous',async()=>{
 const h=harness();try{h.add();h.socket.sendMessage=async()=>undefined;await h.manager.check();assert.equal(h.sql.prepare("SELECT state FROM delivery_runs WHERE key='post:1'").get().state,'ambiguous');assert.equal(h.deleted.length,0);}finally{h.close();}
});
test('configured preview recovery closes earlier without sending late',async()=>{
 const h=harness('2026-10-31T15:30:00Z');try{h.restart({previewWindowMinutes:2});h.socket=null;await h.manager.check();h.socket=h.freshSocket();h.time('2026-10-31T15:33:00Z');await h.manager.check();assert.equal(h.sends.length,0);}finally{h.close();}
});
test('configured midnight recovery window rejects late automatic dispatch',async()=>{
 const h=harness();try{h.restart({dispatchWindowMinutes:1});h.add();h.socket=null;await h.manager.check();h.time('2026-11-02T18:32:00Z');h.socket=h.freshSocket();await h.manager.check();assert.equal(h.sends.length,0);}finally{h.close();}
});
test('private admin digest is bounded to one per date after reconnection',async()=>{
 const h=harness();try{h.restart({adminAlertJid:'admin'});h.add({image_path:'missing.jpg'});h.socket=null;await h.manager.check();h.socket=h.freshSocket();await h.manager.check();await h.manager.check();assert.equal(h.sends.filter(s=>s.chat==='admin').length,1);}finally{h.close();}
});
test('stopped manager does not send and paused automatic work resumes safely',async()=>{
 const h=harness();try{h.add();h.db.paused=true;await h.manager.check();assert.equal(h.sends.length,0);h.db.paused=false;await h.manager.check();assert.equal(h.sends.length,1);h.manager.stop();h.add();await h.manager.check();assert.equal(h.sends.length,1);}finally{h.close();}
});
test('session private keys are excluded from known library logs',()=>{
 const output=[];const target=Object.fromEntries(['info','warn','log'].map(k=>[k,(...args)=>output.push(args)]));
 require('../src/safe-logging').protectSessionLogs(target);
 target.info('Closing session:',{privateKey:'SECRET'});target.warn('Session already closed',{privateKey:'SECRET'});target.log('normal');
 assert.doesNotMatch(JSON.stringify(output),/SECRET/);assert.equal(output[2][0],'normal');
});

test('offline manual dispatch for tomorrow stays eligible at midnight', async () => {
  const h = harness('2026-11-02T17:00:00Z');
  try {
    h.add(); h.socket = null;
    await h.manager.dispatchTodaysPosts('2026-11-03');
    h.time('2026-11-02T18:30:00Z'); h.socket = h.freshSocket();
    await h.manager.check();
    assert.equal(h.sends.filter(s => s.chat === 'main').length, 1);
    assert.equal(h.rows[0].status, 'completed');
  } finally { h.close(); }
});

test('a hung send times out, retains image and never retries even if late acknowledgement arrives', async () => {
  const h = harness();
  try {
    h.add(); let accept;
    h.socket.sendMessage = () => new Promise(resolve => { accept = resolve; });
    const run = h.manager.check();
    const timeout = [...h.timeouts].find(([, delay]) => delay === 45000)[0];
    timeout(); await run;
    accept({ key: { id: 'late-ack' } }); await Promise.resolve();
    h.socket = h.freshSocket(); await h.manager.check();
    assert.equal(h.sql.prepare("SELECT state FROM delivery_runs WHERE key='post:1'").get().state, 'ambiguous');
    assert.equal(h.deleted.length, 0); assert.equal(h.sends.length, 0);
    assert.equal(h.timeouts.size, 0);
  } finally { h.close(); }
});

test('health persists preview and backup results across restart and includes full counts', async () => {
  const h = harness('2026-12-31T15:30:00Z');
  try {
    await h.manager.check(); assert.match(h.sends[0].content.text, /01 Jan 2027/);
    h.restart(); const health = h.manager.health();
    assert.equal(health.lastPreview, '2026-12-31T15:30:00.000Z');
    assert.equal(health.lastPreviewResult.state, 'completed');
    assert.equal(health.lastBackup.state, 'completed');
    assert.equal(health.lastSend, '2026-12-31T15:30:00.000Z');
    assert.equal(health.unresolvedAlerts, 0);
    await h.manager.check(); assert.equal(h.sends.length, 1);
  } finally { h.close(); }
});
test('SQLite backup includes uncheckpointed WAL and passes integrity check',async()=>{
 const os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'birthday-backup-test-'));
 let live,copy;
 try{live=new Database(path.join(dir,'live.db'));live.pragma('journal_mode = WAL');live.pragma('wal_autocheckpoint = 0');live.exec('CREATE TABLE birthdays(name TEXT)');live.prepare('INSERT INTO birthdays VALUES (?)').run('WAL test');
 const source=fs.readFileSync(path.join(__dirname,'../src/database.js'),'utf8');const mod={exports:{}};
 vm.runInNewContext(source,{module:mod,exports:mod.exports,__dirname:dir,require:n=>n==='better-sqlite3'?function(){return live;}:n==='path'?{...path,join:(...parts)=>parts.includes('backups')?path.join(dir,'backups'):path.join(...parts)}:fs,process:{env:{}},console:{log(){},error(){}},Date});
 await mod.exports.backupDatabase();const files=fs.readdirSync(path.join(dir,'backups'));assert.equal(files.length,1);
 copy=new Database(path.join(dir,'backups',files[0]),{readonly:true});assert.equal(copy.prepare('SELECT name FROM birthdays').get().name,'WAL test');assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');
 }finally{copy?.close();live?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('update confirmation sends only to Reps at 10 AM and is not repeated after restart', async () => {
  const h = harness('2026-11-02T04:29:59Z');
  const config = { updateNoticeAt: '2026-11-02T10:00:00+05:30' };
  try {
    h.restart(config); await h.manager.check(); assert.equal(h.sends.length, 0);
    h.time('2026-11-02T04:30:00Z'); await h.manager.check(); await h.manager.check();
    assert.equal(h.sends.length, 1); assert.equal(h.sends[0].chat, 'rep');
    assert.match(h.sends[0].content.text, /Birthday Bot updated successfully!/);
    h.restart(config); await h.manager.check(); assert.equal(h.sends.length, 1);
    assert.equal(h.manager.health().updateNotice.result.state, 'completed');
  } finally { h.close(); }
});

test('update confirmation recovers a disconnected socket within 15 minutes but never sends an expired notice', async () => {
  const h = harness('2026-11-02T04:30:00Z');
  const config = { updateNoticeAt: '2026-11-02T10:00:00+05:30' };
  try {
    h.restart(config); h.socket = null; await h.manager.check(); assert.equal(h.sends.length, 0);
    h.time('2026-11-02T04:33:00Z'); h.socket = h.freshSocket(); await h.manager.check();
    assert.equal(h.sends.length, 1);
    h.restart({ updateNoticeAt: '2026-11-01T10:00:00+05:30' }); await h.manager.check();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sql.prepare("SELECT state FROM delivery_runs WHERE key=?").get('update-notice:2026-11-01T04:30:00.000Z').state, 'expired');
  } finally { h.close(); }
});

test('uncertain update confirmation is never automatically resent', async () => {
  const h = harness('2026-11-02T04:30:00Z');
  try {
    h.restart({ updateNoticeAt: '2026-11-02T10:00:00+05:30' });
    h.socket.sendMessage = async () => { h.sends.push({}); throw Error('Connection closed after send'); };
    await h.manager.check(); h.socket = h.freshSocket(); await h.manager.check();
    assert.equal(h.sends.length, 1); assert.equal(h.manager.health().updateNotice.result.state, 'ambiguous');
  } finally { h.close(); }
});
