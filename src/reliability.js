'use strict';

const fs = require('fs');
const cron = require('node-cron');
const { sendDailyPreview, sendBirthdayPost } = require('./scheduler');

function localParts(now, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

function createManager({ db, getSocket, mainGroupId, repGroupId, timezone = 'Asia/Colombo',
  clock = () => new Date(), timers = globalThis, scheduler = cron,
  dispatchWindowMinutes = 120, previewWindowMinutes = 180, adminAlertJid = null, updateNoticeAt = null }) {
  for (const n of [dispatchWindowMinutes, previewWindowMinutes]) {
    if (!Number.isFinite(n) || n < 1 || n > 1440) throw new Error('Invalid recovery window');
  }
  previewWindowMinutes = Math.min(previewWindowMinutes, 180);
  const noticeTime = updateNoticeAt ? Date.parse(updateNoticeAt) : null;
  if (updateNoticeAt && (!/(Z|[+-]\d{2}:\d{2})$/.test(updateNoticeAt) || !Number.isFinite(noticeTime))) {
    throw new Error('UPDATE_NOTICE_AT must be an ISO timestamp with a timezone');
  }
  const sql = db.getDb();
  sql.exec(`CREATE TABLE IF NOT EXISTS delivery_runs (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    message_id TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS scheduler_alerts (
    key TEXT PRIMARY KEY, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_activity (
    kind TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_date TEXT);
  `);
  const stamp = () => clock().toISOString();
  const alert = (key, detail) => {
    const existing = sql.prepare('SELECT detail FROM scheduler_alerts WHERE key=?').get(key);
    if (existing?.detail === detail) return;
    sql.prepare('INSERT OR REPLACE INTO scheduler_alerts VALUES (?, ?, ?)').run(key, detail, stamp());
    console.warn(JSON.stringify({ component: 'scheduler', event: 'needs_review', key, detail }));
  };
  // An interrupted send may already have reached WhatsApp. Never blindly replay it.
  sql.prepare("UPDATE delivery_runs SET state = 'ambiguous', detail = 'Process stopped during delivery' WHERE state = 'in_progress' AND kind != 'backup'").run();
  sql.prepare("UPDATE delivery_runs SET state = 'retryable' WHERE state = 'in_progress' AND kind = 'backup'").run();
  for (const row of sql.prepare("SELECT key FROM delivery_runs WHERE state = 'ambiguous'").all()) alert(row.key, 'Interrupted delivery requires review');
  let started = false, stopped = false, checking = false;
  let jobs = [], timer;
  let lastCheck = null, lastDispatch = null, lastPreview = null, lastSend = null;
  const inflight = new Map();
  const state = key => sql.prepare('SELECT * FROM delivery_runs WHERE key = ?').get(key);
  const ensure = (key, kind) => sql.prepare("INSERT OR IGNORE INTO delivery_runs(key,kind,state,updated_at) VALUES (?,?,'pending',?)").run(key, kind, stamp());
  const update = (key, value, detail = null, id = null) => sql.prepare('UPDATE delivery_runs SET state=?,detail=?,message_id=?,updated_at=? WHERE key=?').run(value, detail, id, stamp(), key);
  const activity = kind => sql.prepare('SELECT * FROM scheduler_activity WHERE kind=?').get(kind);
  const recordStart = kind => sql.prepare(`INSERT INTO scheduler_activity(kind,started_at) VALUES (?,?)
    ON CONFLICT(kind) DO UPDATE SET started_at=excluded.started_at`).run(kind, stamp());
  function deliver(key, kind, send, { network = true } = {}) {
    if (inflight.has(key)) return inflight.get(key).then(result => ({ ...result, sent: false }));
    const work = (async () => {
      ensure(key, kind);
      const row = state(key);
      if (!['pending', 'retryable'].includes(row.state)) return { state: row.state, sent: false };
      if (stopped) return { state: 'retryable', sent: false };
      const socket = getSocket();
      if (network && (!socket || socket.ws?.isOpen === false)) {
        update(key, 'retryable', 'WhatsApp disconnected before send');
        alert(key, 'Waiting for WhatsApp connection');
        return { state: 'retryable', sent: false };
      }
      const claimed = sql.prepare("UPDATE delivery_runs SET state='in_progress',attempts=attempts+1,updated_at=? WHERE key=? AND state IN ('pending','retryable')").run(stamp(), key).changes;
      if (!claimed) return { state: state(key).state, sent: false };
      try {
        if (network && (socket !== getSocket() || socket.ws?.isOpen === false)) {
          update(key, 'retryable', 'Connection changed before send');
          return { state: 'retryable', sent: false };
        }
        let timeout;
        let result;
        try {
          result = network ? await Promise.race([
            send(socket),
            new Promise((_, reject) => { timeout = timers.setTimeout(() => reject(new Error('Send timeout')), 45000); })
          ]) : await send(socket);
        } finally { if (timeout) timers.clearTimeout(timeout); }
        if (network && !result?.key?.id) throw new Error('No application acknowledgement');
        update(key, 'completed', null, result?.key?.id || null);
        sql.prepare('DELETE FROM scheduler_alerts WHERE key=?').run(key);
        if (network) lastSend = stamp();
        console.log(JSON.stringify({ component: 'scheduler', event: 'completed', key }));
        return { state: 'completed', sent: true };
      } catch (err) {
        // Once sendMessage was invoked, even "Connection Closed" is uncertain.
        const outcome = network ? 'ambiguous' : 'retryable';
        update(key, outcome, network ? 'Send outcome unknown; review before retry' : 'Backup failed');
        alert(key, network ? 'Send outcome unknown; no automatic retry' : 'Backup failed');
        return { state: outcome, sent: false };
      }
    })();
    inflight.set(key, work);
    work.finally(() => inflight.delete(key)).catch(() => {});
    return work;
  }
  async function sendPost(post) {
    if (stopped) return false;
    post = db.getPostById(post.id);
    if (!post) return false;
    const key = `post:${post.id}`;
    if (post.birthday < localParts(clock(), timezone).date) {
      alert(key, 'Historical birthday requires manual review'); return false;
    }
    if (post.birthday === '2026-11-01' && post.name.trim().replace(/\s+/g, ' ').toLowerCase() === 'sasini hansika') {
      ensure(key, 'birthday'); update(key, 'completed', 'Manually published; incident exclusion');
      return false;
    }
    if (db.isBotPaused() || post.status !== 'pending') return false;
    const prior = state(key);
    if (prior?.state === 'completed') { db.markCompleted(post.id); return false; }
    if (prior && !['pending', 'retryable', 'in_progress'].includes(prior.state)) return false;
    if (post.image_path !== 'text-mode' && !fs.existsSync(post.image_path)) {
      ensure(key, 'birthday'); update(key, 'permanent', 'Image missing');
      db.markFailed(post.id); alert(key, 'Image missing'); return false;
    }
    const result = await deliver(key, 'birthday', socket => sendBirthdayPost(socket, mainGroupId, post));
    if (result.sent) {
      db.markCompleted(post.id);
      if (post.image_path !== 'text-mode' && fs.existsSync(post.image_path)) {
        try { fs.unlinkSync(post.image_path); } catch { alert(`cleanup:${post.id}`, 'Delivered image could not be removed'); }
      }
    }
    return result.sent;
  }
  async function dispatch(date = localParts(clock(), timezone).date, automatic = false) {
    lastDispatch = stamp();
    recordStart('dispatch');
    let count = 0;
    if (db.isBotPaused()) return count;
    for (const post of db.getPendingForToday(date)) {
      if (automatic) {
        const current = localParts(clock(), timezone);
        if (current.date !== date || current.minute >= dispatchWindowMinutes) break;
        const created = new Date(post.created_at.replace(' ', 'T') + 'Z');
        if (Number.isNaN(created.getTime()) || localParts(created, timezone).date >= date) continue;
      }
      if (count) await new Promise(resolve => timers.setTimeout(resolve, 3000));
      if (automatic) {
        const current = localParts(clock(), timezone);
        if (current.date !== date || current.minute >= dispatchWindowMinutes) break;
      }
      if (await sendPost(post)) count++;
    }
    return count;
  }
  async function preview(date) {
    if (activity('preview')?.completed_date === date) return;
    lastPreview = stamp();
    recordStart('preview');
    let part = 0;
    // Only the transport is substituted: original preview layout/query stays intact.
    const proxy = { sendMessage: async (chat, content, options) => {
      const key = `preview:${date}:${part++}`;
      const current = localParts(clock(), timezone);
      if (current.date !== date || current.minute < 1260 || current.minute >= 1260 + previewWindowMinutes) {
        ensure(key, 'preview'); update(key, 'expired', 'Preview expired before send');
        alert(key, 'Preview expired before send'); throw new Error('Expired preview');
      }
      const result = await deliver(key, 'preview', socket => socket.sendMessage(chat, content, options));
      if (result.state !== 'completed') throw new Error('Preview pending or needs review');
      return { key: { id: state(key).message_id } };
    } };
    if (await sendDailyPreview(proxy, repGroupId)) {
      sql.prepare("UPDATE scheduler_activity SET completed_date=? WHERE kind='preview'").run(date);
      sql.prepare('DELETE FROM scheduler_alerts WHERE key=?').run(`preview-run:${date}`);
    } else {
      alert(`preview-run:${date}`, 'Preview incomplete; inspect delivery results before manual action');
    }
  }
  async function check() {
    if (checking || stopped) return;
    checking = true;
    try {
      const now = localParts(clock(), timezone);
      lastCheck = stamp();
      if (noticeTime !== null && clock().getTime() >= noticeTime) {
        const key = `update-notice:${new Date(noticeTime).toISOString()}`;
        if (clock().getTime() < noticeTime + 15 * 60000) {
          await deliver(key, 'update-notice', socket => socket.sendMessage(repGroupId, {
            text: '✅ Birthday Bot updated successfully!\n\nThis scheduled test message confirms the bot is connected and can send automatic messages. 🤖'
          }));
        } else if (!state(key) || ['pending', 'retryable'].includes(state(key).state)) {
          ensure(key, 'update-notice'); update(key, 'expired', 'Update confirmation window elapsed');
          alert(key, 'Update confirmation was not sent within 15 minutes of its scheduled time');
        }
      }
      // Expire old retries; alerts remain durable for administrator review.
      for (const row of sql.prepare("SELECT key,kind,updated_at FROM delivery_runs WHERE state IN ('pending','retryable')").all()) {
        const oldDate = localParts(new Date(row.updated_at), timezone).date;
        const birthday = row.kind === 'birthday' ? db.getPostById(Number(row.key.slice(5)))?.birthday : null;
        if ((row.kind === 'preview' && (oldDate !== now.date || now.minute >= 1260 + previewWindowMinutes)) ||
            (row.kind === 'birthday' && birthday && birthday < now.date)) {
          update(row.key, 'expired', 'Recovery window elapsed'); alert(row.key, 'Recovery window elapsed');
        }
      }
      if (now.minute < dispatchWindowMinutes) await dispatch(now.date, true);
      else for (const post of db.getPendingForToday(now.date)) {
        if (localParts(new Date(post.created_at.replace(' ', 'T') + 'Z'), timezone).date < now.date && state(`post:${post.id}`)?.state !== 'completed') alert(`post:${post.id}`, 'Automatic recovery window elapsed');
      }
      if (now.minute >= 1260 && now.minute < 1260 + previewWindowMinutes) await preview(now.date);
      if (now.minute >= 5) await deliver(`backup:${now.date}`, 'backup', () => db.backupDatabase(), { network: false });
      const unresolved = sql.prepare('SELECT COUNT(*) AS n FROM scheduler_alerts').get().n;
      if (unresolved && adminAlertJid && adminAlertJid !== repGroupId && adminAlertJid !== mainGroupId) {
        await deliver(`admin-alert:${now.date}`, 'alert', socket => socket.sendMessage(adminAlertJid, {
          text: `Scheduler needs review: ${unresolved} unresolved alert(s). Check the protected /health endpoint and server logs. No uncertain deliveries will be retried automatically.`
        }));
      }
    } catch (err) { alert('scheduler:check', 'Scheduler check failed'); }
    finally { checking = false; }
  }
  function stop() {
    stopped = true; started = false;
    for (const job of jobs) job.destroy();
    jobs = []; if (timer) timers.clearInterval(timer); timer = null;
  }
  function start() {
    if (started) return;
    started = true; stopped = false;
    try {
      for (const expression of ['0 0 * * *', '0 21 * * *', '5 0 * * *']) {
        const job = scheduler.schedule(expression, check, { timezone, noOverlap: true, missedExecutionTolerance: 60000 });
        jobs.push(job);
        job.on?.('execution:missed', () => { alert(`cron:${expression}`, 'Missed tick; recovery requested'); void check(); });
      }
      timer = timers.setInterval(() => void check(), 30000); timer.unref?.();
      void check();
    } catch (err) { stop(); throw err; }
  }
  function health() {
    const latest = kind => sql.prepare('SELECT * FROM delivery_runs WHERE kind=? ORDER BY updated_at DESC LIMIT 1').get(kind) || null;
    const lastSuccess = sql.prepare("SELECT updated_at FROM delivery_runs WHERE state='completed' AND kind!='backup' AND message_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get();
    return { process: 'running', whatsapp: Boolean(getSocket()), initialized: started,
      activeJobs: jobs.length, duplicateScheduler: jobs.length > 3, lastCheck,
      lastDispatch: lastDispatch || activity('dispatch')?.started_at || null,
      lastPreview: lastPreview || activity('preview')?.started_at || null,
      lastSend: lastSend || lastSuccess?.updated_at || null,
      lastPreviewResult: latest('preview'), lastBirthdayResult: latest('birthday'), lastBackup: latest('backup'),
      updateNotice: { scheduledAt: updateNoticeAt, result: latest('update-notice') },
      deliveryCounts: sql.prepare('SELECT state,COUNT(*) AS count FROM delivery_runs GROUP BY state').all(),
      unresolvedAlerts: sql.prepare('SELECT COUNT(*) AS count FROM scheduler_alerts').get().count,
      runs: sql.prepare('SELECT * FROM delivery_runs ORDER BY updated_at DESC LIMIT 30').all(),
      alerts: sql.prepare('SELECT * FROM scheduler_alerts ORDER BY created_at DESC LIMIT 30').all() };
  }
  return { start, stop, check, health, dispatchTodaysPosts: dispatch,
    sendPost: id => { const post = db.getPostById(id); return post ? sendPost(post) : Promise.resolve(false); },
    drain: () => Promise.allSettled([...inflight.values()]) };
}

module.exports = { createManager, localParts };
