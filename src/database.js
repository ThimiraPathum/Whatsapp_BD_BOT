'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs'); // 👈 1. fs මොඩියුල් එක මෙහි එකතු කර ඇත

const DB_PATH = path.join(__dirname, '..', 'data', 'birthdays.db');

let db;

function getDb() {
  if (!db) {
    // ⚠️ 2. data ෆෝල්ඩරය නැත්නම් ස්වයංක්‍රීයව සෑදීම
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS birthday_posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      birthday    TEXT    NOT NULL,          -- ISO date: YYYY-MM-DD
      image_path  TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | completed | failed
      msg_id      TEXT,                     -- WhatsApp message ID of original upload
      chat_id     TEXT,                     -- Rep group chat ID
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      posted_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS form_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      birthday TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_design',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_birthday_status
      ON birthday_posts (birthday, status);
  `);

  // Auto-sync existing posts: If a form submission matches an already existing post, mark it as designed.
  getDb().exec(`
    -- 1. Fix dirty dates (e.g., 2003-09-03T18:00:00.000Z -> 2003-09-03)
    UPDATE form_submissions
    SET birthday = substr(birthday, 1, 10)
    WHERE birthday LIKE '%T%';

    -- 2. Force the year to be the upcoming year (e.g. 2003 -> 2026 or 2027)
    UPDATE form_submissions
    SET birthday = 
      CASE 
        WHEN strftime('%m-%d', birthday) < strftime('%m-%d', 'now') 
        THEN cast(strftime('%Y', 'now') + 1 as text) || '-' || strftime('%m-%d', birthday)
        ELSE strftime('%Y', 'now') || '-' || strftime('%m-%d', birthday)
      END
    WHERE substr(birthday, 1, 4) != strftime('%Y', 'now') 
      AND substr(birthday, 1, 4) != cast(strftime('%Y', 'now') + 1 as text);

    -- 3. Mark as designed if it matches existing post
    UPDATE form_submissions 
    SET status = 'designed' 
    WHERE status = 'pending_design' 
    AND EXISTS (
      SELECT 1 FROM birthday_posts 
      WHERE birthday_posts.name = form_submissions.name 
      AND birthday_posts.birthday = form_submissions.birthday
    );
  `);
}

// ─── Form Submissions ────────────────────────────────────────────────────────

function insertFormSubmission({ name, birthday, photoUrl }) {
  const existing = getDb().prepare('SELECT id FROM form_submissions WHERE name = ? AND birthday = ?').get(name, birthday);
  if (existing) return existing.id; // Avoid duplicates

  const stmt = getDb().prepare(
    'INSERT INTO form_submissions (name, birthday, photo_url) VALUES (?, ?, ?)'
  );
  const info = stmt.run(name, birthday, photoUrl);
  return info.lastInsertRowid;
}

function getFormSubmissionsByMonth(monthString) {
  // monthString format: '-MM-' e.g., '-10-'
  return getDb().prepare(
    "SELECT * FROM form_submissions WHERE birthday LIKE ? ORDER BY strftime('%m-%d', birthday) ASC"
  ).all(`%${monthString}%`);
}

function clearFormSubmissions() {
  getDb().prepare('DELETE FROM form_submissions').run();
}

function markDesignCompleted(name, birthday) {
  const stmt = getDb().prepare(
    "UPDATE form_submissions SET status = 'designed' WHERE name = ? AND birthday = ? AND status = 'pending_design'"
  );
  stmt.run(name, birthday);
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Insert a new pending birthday post.
 * @returns {number} The new row id
 */
function insertPost({ name, birthday, imagePath, msgId, chatId }) {
  const stmt = getDb().prepare(`
    INSERT INTO birthday_posts (name, birthday, image_path, msg_id, chat_id)
    VALUES (@name, @birthday, @imagePath, @msgId, @chatId)
  `);
  const result = stmt.run({ name, birthday, imagePath, msgId, chatId });
  
  // Also auto-mark the form submission as designed if it exists
  markDesignCompleted(name, birthday);
  
  return result.lastInsertRowid;
}

/**
 * Fetch all pending posts whose birthday matches today (YYYY-MM-DD).
 */
function getPendingForToday(dateStr) {
  return getDb()
    .prepare(
      `SELECT * FROM birthday_posts
       WHERE birthday = ? AND status = 'pending'
       ORDER BY id`
    )
    .all(dateStr);
}

/**
 * Mark a post as completed after sending.
 */
function markCompleted(id) {
  getDb()
    .prepare(
      `UPDATE birthday_posts
       SET status = 'completed', posted_at = datetime('now')
       WHERE id = ?`
    )
    .run(id);
}

/**
 * Mark a post as failed (e.g. image missing at dispatch time).
 */
function markFailed(id) {
  getDb()
    .prepare(`UPDATE birthday_posts SET status = 'failed' WHERE id = ?`)
    .run(id);
}

/**
 * Check whether an identical post is already scheduled (dedup guard).
 */
function postExists({ name, birthday }) {
  const row = getDb()
    .prepare(
      `SELECT id FROM birthday_posts
       WHERE name = ? AND birthday = ? AND status = 'pending'`
    )
    .get(name, birthday);
  return !!row;
}

/**
 * Return a full listing (for the /list admin command).
 */
function listPending() {
  return getDb()
    .prepare(
      `SELECT id, name, birthday, status, created_at
       FROM birthday_posts
       WHERE status = 'pending'
       ORDER BY birthday`
    )
    .all();
}

/**
 * Delete a pending post by id (for the /cancel admin command).
 */
function cancelPost(id) {
  return getDb()
    .prepare(
      `DELETE FROM birthday_posts WHERE id = ? AND status = 'pending'`
    )
    .run(id).changes;
}

/**
 * Get a post by its ID.
 */
function getPostById(id) {
  return getDb()
    .prepare(`SELECT * FROM birthday_posts WHERE id = ?`)
    .get(id);
}

/**
 * Backup the database file (keeps the last 7 days of backups).
 */
function backupDatabase() {
  try {
    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const backupPath = path.join(backupDir, `birthdays_${dateStr}.db`);

    // Copy the database file
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[Database] Backup created at: ${backupPath}`);

    // Delete backups older than 7 days
    const files = fs.readdirSync(backupDir);
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    files.forEach(file => {
      const filePath = path.join(backupDir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > SEVEN_DAYS) {
        fs.unlinkSync(filePath);
        console.log(`[Database] Deleted old backup: ${file}`);
      }
    });
  } catch (err) {
    console.error(`[Database] Backup failed:`, err);
  }
}

function isBotPaused() {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get('is_paused');
  return row && row.value === 'true';
}

function setBotPaused(isPaused) {
  getDb().prepare(`
    INSERT INTO config (key, value) VALUES ('is_paused', ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(isPaused ? 'true' : 'false', isPaused ? 'true' : 'false');
}

module.exports = {
  insertPost,
  getPendingForToday,
  markCompleted,
  markFailed,
  postExists,
  listPending,
  cancelPost,
  getPostById,
  backupDatabase,
  isBotPaused,
  setBotPaused,
  insertFormSubmission,
  getFormSubmissionsByMonth,
  markDesignCompleted,
  clearFormSubmissions,
};