'use strict';

/**
 * scheduler.js — Baileys version
 * Registers a cron job that fires at 00:00:00 every day (Asia/Colombo timezone).
 * Queries the DB for pending posts matching today's date and sends them to the
 * Main Group via the Baileys socket.
 */

const cron = require('node-cron');
const fs = require('fs');
const db = require('./database');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

/**
 * Build the standardised caption for a birthday post.
 */
function buildCaption(name, birthday) {
  // නමේ කොටස් ටික හිස්තැන් වලින් වෙන් කරගන්නවා
  const parts = name.trim().split(/\s+/);
  let firstName = parts[0]; // සාමාන්යයෙන් මුල්ම වචනය

  // මුලින්ම තියෙන්නේ Initials නම් (උදා: K. M. Kasun), නියම මුල් නම හොයාගන්නවා
  for (const part of parts) {
    if (part.length > 2 && !part.includes('.')) {
      firstName = part;
      break;
    }
  }

  const template =
    process.env.BIRTHDAY_CAPTION ||
    'Happy Birthday, {name}! 🎊\n' +
    'May your day be as bright and inspiring as your journey at the university. ' +
    'Wishing you success in your studies, joy in every moment, and strength to achieve all your dreams. ' +
    'We’re proud to celebrate this special day with you at the university.';

  // {name} කියන තැනට සම්පූර්ණ නම වෙනුවට අර අපි වෙන් කරගත්ත First Name එක දානවා
  return template.replace(/\{name\}/gi, firstName).replace(/\{date\}/gi, birthday);
}

/**
 * Send a single birthday post (image + caption, or text-only fallback).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} mainGroupId
 * @param {object} post
 */
async function sendBirthdayPost(sock, mainGroupId, post) {
  const caption = buildCaption(post.name, post.birthday);

  if (post.image_path && post.image_path !== 'text-mode' && fs.existsSync(post.image_path)) {
    await sock.sendMessage(mainGroupId, {
      image: fs.readFileSync(post.image_path),
      caption,
    });
  } else {
    // text-mode entries have no image — send caption only
    await sock.sendMessage(mainGroupId, { text: caption });
  }
}

/**
 * Called once at startup and by the cron tick.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} mainGroupId  WhatsApp chat ID for the main group
 */
async function dispatchTodaysPosts(sock, mainGroupId, forceDate = null) {
  const targetDate = forceDate || new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
  console.log(`[Scheduler] Checking for birthday posts on ${targetDate}…`);

  const posts = db.getPendingForToday(targetDate);
  if (posts.length === 0) {
    console.log('[Scheduler] No pending posts for today.');
    return;
  }

  if (db.isBotPaused()) {
    console.log('[Scheduler] ⚠️ Bot is PAUSED. Skipping automatic dispatch.');
    return;
  }

  console.log(`[Scheduler] Found ${posts.length} post(s) to dispatch.`);

  for (const post of posts) {
    try {
      // text-mode posts have no image on disk by design — only check when a real path is expected
      if (post.image_path && post.image_path !== 'text-mode' && !fs.existsSync(post.image_path)) {
        console.error(`[Scheduler] Image not found: ${post.image_path} — marking failed.`);
        db.markFailed(post.id);
        continue;
      }

      await sendBirthdayPost(sock, mainGroupId, post);
      db.markCompleted(post.id);

      console.log(`[Scheduler] ✅ Posted birthday for ${post.name} (id=${post.id})`);

      // 🔴 අලුත්: Storage Auto-Cleanup (Post කළ පසු පින්තූරය මකා දැමීම)
      if (post.image_path && post.image_path !== 'text-mode' && fs.existsSync(post.image_path)) {
        try {
          fs.unlinkSync(post.image_path);
          console.log(`[Scheduler] 🗑️ Auto-Cleaned up image: ${post.image_path}`);
        } catch (err) {
          console.error('[Scheduler] ⚠️ Error cleaning image:', err.message);
        }
      }

      // Small delay between multiple posts to avoid rate-limiting
      if (posts.indexOf(post) < posts.length - 1) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error(`[Scheduler] Failed to post for ${post.name}:`, err.message);
      db.markFailed(post.id);
    }
  }
  return posts.length;
}

/**
 * Register the midnight cron job.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} mainGroupId
 */
function startScheduler(sock, mainGroupId) {
  // "0 0 * * *" = at 00:00 every day
  const job = cron.schedule('0 0 * * *', () => dispatchTodaysPosts(sock, mainGroupId), {
    timezone: TIMEZONE,
  });

  job.start();
  console.log(`[Scheduler] Midnight dispatch job registered (TZ: ${TIMEZONE})`);

  // 🔴 අලුත්: Database Auto Backup Job
  const backupJob = cron.schedule('5 0 * * *', () => {
    console.log(`[Scheduler] Running daily database backup...`);
    db.backupDatabase();
  }, {
    timezone: TIMEZONE,
  });
  backupJob.start();
  console.log(`[Scheduler] Daily database backup job registered (00:05 AM)`);

  return { dispatchTodaysPosts: () => dispatchTodaysPosts(sock, mainGroupId) };
}

// 🔴 New: Daily Preview (9:00 PM every day)
function startDailyPreview(sock, repGroupId) {
  // "0 21 * * *" = 9:00 PM every day
  const job = cron.schedule('0 21 * * *', async () => {
    try {
      // Tomorrow's date calculation
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

      const upcoming = db.getPendingForToday(tomorrowStr);

      let msg = '';
      if (upcoming.length === 0) {
        msg = `╭━━━ 🌙 MIDNIGHT PREVIEW ━━━╮\n\n📅 Tonight's Automatic Dispatch\n\n🕛 12:00 AM\n\n━━━━━━━━━━━━━━━━━━\n\n🎂 Scheduled Birthdays\n\n➖ No birthdays scheduled for tonight.\n\n━━━━━━━━━━━━━━━━━━\n\n⚠️ Please Review\n\nIf you believe a birthday is missing, please contact Piyumal before 12:00 AM.\n\n✅ No automatic birthday posts are currently scheduled.`;
      } else {
        msg = `╭━━━ 🌙 MIDNIGHT PREVIEW ━━━╮\n\n📅 Tonight's Automatic Dispatch\n\nThe following birthdays will be sent to the Main Group at:\n\n🕛 12:00 AM\n\n━━━━━━━━━━━━━━━━━━\n\n🎂 Scheduled Birthdays\n\n`;
        upcoming.forEach((p, i) => { 
          msg += `${i + 1}. 👤 ${p.name}\n　 🆔 ID: #${p.id}\n\n`; 
        });
        msg += `━━━━━━━━━━━━━━━━━━\n\n⚠️ Please Review\n\nIf any birthday is missing or incorrect, please contact Piyumal before 12:00 AM.\n\nThis is an automatic dispatch. No action is required if everything is correct.`;
      }

      await sock.sendMessage(repGroupId, { text: msg });
      console.log(`[Scheduler] 🔔 Daily preview sent to Reps for ${tomorrowStr}.`);
    } catch (err) {
      console.error('[Scheduler] ⚠️ Error sending daily preview:', err.message);
    }
  }, { timezone: TIMEZONE });
  
  job.start();
  console.log(`[Scheduler] Daily preview job registered (09:00 PM)`);
}

module.exports = { startScheduler, dispatchTodaysPosts, startDailyPreview };