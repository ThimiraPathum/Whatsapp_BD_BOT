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

    CREATE INDEX IF NOT EXISTS idx_birthday_status
      ON birthday_posts (birthday, status);
  `);
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

module.exports = {
  insertPost,
  getPendingForToday,
  markCompleted,
  markFailed,
  postExists,
  listPending,
  cancelPost,
  getPostById,
};