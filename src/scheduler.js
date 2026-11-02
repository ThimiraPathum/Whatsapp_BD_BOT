'use strict';

const { sendRepMessage } = require('./rep-messages');
const { card, formatDate } = require('./message-layout');

/**
 * scheduler.js — Baileys version
 * Message rendering and transport. Scheduling and durable delivery ownership
 * are managed by reliability.js.
 */

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
    return await sock.sendMessage(mainGroupId, {
      image: fs.readFileSync(post.image_path),
      caption,
    });
  } else {
    // text-mode entries have no image — send caption only
    return await sock.sendMessage(mainGroupId, { text: caption });
  }
}

async function sendDailyPreview(sock, repGroupId) {
    try {
      // Tomorrow's date calculation
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

      const upcoming = db.getPendingForToday(tomorrowStr);
      const dispatchTime = `📅 *${formatDate(tomorrowStr)}* · 12:00 AM`;
      const destination = `📍 Main Group · ${TIMEZONE === 'Asia/Colombo' ? 'ශ්‍රී ලංකා වේලාවෙන්' : TIMEZONE}`;

      let msg = '';
      if (upcoming.length === 0) {
        msg = card(
          '🌙 රාත්‍රී 12:00 පෙරදැකීම (Preview)',
          `${dispatchTime}\n${destination}`,
          '*යැවීමට සූදානම් · 0*\nඅද රාත්‍රී 12:00 ට යැවීමට පෝස්ටු ඇතුළත් කර නැත.',
          '*කරුණාකර පරීක්ෂා කරන්න*\nකිසියම් උපන්දිනයක් මඟහැරී ඇත්නම්, රාත්‍රී 12:00 ට පෙර Piyumal දැනුවත් කරන්න.'
        );
      } else {
        const readyList = upcoming.map(p => `• ${p.name} · #${p.id}`).join('\n');
        msg = card(
          '🌙 රාත්‍රී 12:00 පෙරදැකීම (Preview)',
          `${dispatchTime}\n${destination}`,
          `*යැවීමට සූදානම් · ${upcoming.length}*\n${readyList}`,
          'මෙම පෝස්ටු අද රාත්‍රී 12:00 ට ස්වයංක්‍රීයව Main Group එකට යැවේ.',
          '*කරුණාකර පරීක්ෂා කරන්න*\nකිසියම් උපන්දිනයක් මඟහැරී ඇත්නම් හෝ වෙනසක් විය යුතු නම්, රාත්‍රී 12:00 ට පෙර Piyumal දැනුවත් කරන්න. සියල්ල නිවැරදි නම් කිසිවක් කිරීමට අවශ්‍ය නැත.'
        );
      }

      await sendRepMessage(sock, repGroupId, { text: msg });

      // Check if there are any Google Form submissions for tomorrow that are NOT designed yet
      const tomorrowMonthDay = tomorrowStr.substring(5); // e.g. '09-27'
      const pendingSubmissions = db.getDb().prepare("SELECT * FROM form_submissions WHERE birthday LIKE ? AND status = 'pending_design'").all(`%-${tomorrowMonthDay}`);
      
      if (pendingSubmissions.length > 0) {
        // Add a 2-second delay so WhatsApp doesn't block the second message for being too fast
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const missingList = pendingSubmissions.map(s => `• ${s.name}`).join('\n');
        const warningMsg = card(
          '🚨 අවශ්‍ය කරන ෆ්ලයර් (Flyers Needed)',
          dispatchTime,
          `*තවමත් ලැබී නැති · ${pendingSubmissions.length}*\n${missingList}`,
          '*කළ යුතු දේ*\nරාත්‍රී 12:00 ට පෙර මෙම ෆ්ලයර් නිර්මාණය කර upload කරන්න. ෆ්ලයර් එක upload කරන තෙක් පෝස්ටුව යැවිය නොහැක.'
        );
        
        await sendRepMessage(sock, repGroupId, { text: warningMsg });
      }
      console.log(`[Scheduler] 🔔 Daily preview sent to Reps for ${tomorrowStr}.`);
      return true;
    } catch (err) {
      console.error('[Scheduler] ⚠️ Error sending daily preview:', err.message);
      return false;
    }

}
module.exports = { sendDailyPreview, sendBirthdayPost };
