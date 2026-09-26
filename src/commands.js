'use strict';

const db = require('./database');
const fs = require('fs');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

/**
 * Handle custom commands in the Rep Group
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} text
 * @param {Function} dispatchNowFunction
 */
async function handleCommand(sock, chatId, text, dispatchNowFunction) {
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/help':
    case '/menu':
      await showHelpMenu(sock, chatId);
      break;

    case '/list':
    case '/pending':
      await listPendingPosts(sock, chatId);
      break;

    case '/cancel':
    case '/delete':
      if (parts.length < 2) {
        await sock.sendMessage(chatId, { text: '⚠️ *ID not provided.*\n\nUsage: `/cancel [ID]`\n(Use `/list` to view IDs).' });
        return;
      }
      await cancelPost(sock, chatId, parts[1]);
      break;

    case '/today':
    case '/tonight':
      await showTonightBirthdays(sock, chatId);
      break;

    case '/status':
    case '/designs':
      await showDesignStatus(sock, chatId, parts[1]);
      break;

    case '/dispatch':
      {
        const msgKey = await sock.sendMessage(chatId, { text: '⚡ *Manual Dispatch Started!* Sending tonight\'s posts to the Main Group...' });
        if (dispatchNowFunction) {
          const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
          const count = await dispatchNowFunction(tomorrow);
          await sock.sendMessage(chatId, { text: `╭━━━ ⚡ DISPATCH COMPLETE ━━━╮\n\n🎉 Successfully dispatched ${count || 0} birthdays to the Main Group.\n\n━━━━━━━━━━━━━━━━━━\n✅ Status: Manual Dispatch Finished`, edit: msgKey.key });
        } else {
          await sock.sendMessage(chatId, { text: '⚠️ Dispatch function is not ready yet.', edit: msgKey.key });
        }
      }
      break;

    case '/pause':
      db.setBotPaused(true);
      await sock.sendMessage(chatId, { text: '╭━━━ ⏸️ BOT PAUSED ━━━╮\n\nThe bot is now paused.\n\n⚠️ It will NOT accept new flyers.\n⚠️ It will NOT dispatch scheduled posts.\n\nType `/resume` to start it again.\n━━━━━━━━━━━━━━━━━━' });
      break;

    case '/clear-form':
      db.clearFormSubmissions();
      await sock.sendMessage(chatId, { text: '✅ *Success!* All pending and designed form submissions have been wiped from the database. You can now re-sync from Google Sheets.' });
      break;

    case '/resume':
      db.setBotPaused(false);
      await sock.sendMessage(chatId, { text: '╭━━━ ▶️ BOT RESUMED ━━━╮\n\nThe bot is now active.\n\n✅ Ready to accept new flyers.\n✅ Scheduled posts will be dispatched.\n━━━━━━━━━━━━━━━━━━' });
      break;

    default:
      if (cmd !== '/add' && cmd !== '/id') {
          await sock.sendMessage(chatId, { text: '❓ *Invalid Command!*\nType `/help` for the command list.' });
      }
      break;
  }
}

async function showHelpMenu(sock, chatId) {
  const menu = `╭━━━ 🤖 BIRTHDAY BOT ━━━╮
　　　　　Command Guide

━━━━━━━━━━━━━━━━━━

📊 FORM & STATUS

🔹 /status
View this month's design progress.

🔹 /status next (or /status 10)
View next month's (or specific month's) design progress.

━━━━━━━━━━━━━━━━━━

🎂 BIRTHDAY MANAGEMENT

🔹 /add [Name] | [Date]
Manual fallback if AI fails to read the flyer.

📸 Photo required

Example:
/add Kasun | 2026-09-18

━━━━━━━━━━━━━━━━━━

📋 VIEW BIRTHDAYS

🔹 /list or /pending
View all upcoming scheduled birthdays.

🔹 /today or /tonight
View birthdays scheduled for tonight's dispatch.

━━━━━━━━━━━━━━━━━━

🛠️ ACTIONS

🔹 /cancel [ID]
Delete a scheduled birthday.

Example:
/cancel 5

🔹 /dispatch
Manually dispatch tonight's birthdays immediately.

🔹 /pause & /resume
Turn the bot off or on in an emergency.

━━━━━━━━━━━━━━━━━━
🤖 Automated Birthday Bot`;
  await sock.sendMessage(chatId, { text: menu.trim() });
}

async function listPendingPosts(sock, chatId) {
  const pending = db.listPending();
  
  if (pending.length === 0) {
    await sock.sendMessage(chatId, { text: '╭━━━ 📅 UPCOMING BIRTHDAYS ━━━╮\n　　　　　Pending Queue\n\n━━━━━━━━━━━━━━━━━━\n\n✅ No posts are currently scheduled.' });
    return;
  }

  let msg = `╭━━━ 📅 UPCOMING BIRTHDAYS ━━━╮\n　　　　　Pending Queue\n\n━━━━━━━━━━━━━━━━━━\n\n`;
  pending.forEach((p, i) => {
    msg += `🆔 #${p.id}\n👤 ${p.name}\n📅 ${p.birthday}\n\n`;
    if (i !== pending.length - 1) {
      msg += `──────────────────\n\n`;
    }
  });
  
  msg += `━━━━━━━━━━━━━━━━━━\n\n📌 Total Pending: ${pending.length}\n\nThese birthdays are waiting for their scheduled dispatch.`;

  await sock.sendMessage(chatId, { text: msg.trim() });
}

async function showTonightBirthdays(sock, chatId) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(tomorrow);

  if (todaysPosts.length === 0) {
    await sock.sendMessage(chatId, { text: `╭━━━ 🌙 TONIGHT'S DISPATCH ━━━╮\n\n📅 For Date: ${tomorrow}\n\n━━━━━━━━━━━━━━━━━━\n\n✅ No birthdays scheduled for tonight.` });
    return;
  }

  let msg = `╭━━━ 🌙 TONIGHT'S DISPATCH ━━━╮\n\n📅 For Date: ${tomorrow}\n\n━━━━━━━━━━━━━━━━━━\n\n`;
  todaysPosts.forEach(p => {
    msg += `🆔 #${p.id} — 👤 ${p.name}\n`;
  });
  
  msg += `\n━━━━━━━━━━━━━━━━━━\n\n🕛 Automatic Dispatch: 12:00 AM\n\n⚡ Use /dispatch to send these birthdays immediately.`;

  await sock.sendMessage(chatId, { text: msg.trim() });
}

async function cancelPost(sock, chatId, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await sock.sendMessage(chatId, { text: '⚠️ *Invalid ID!* Please provide a valid number.' });
    return;
  }

  const post = db.getPostById(id);
  if (!post || post.status !== 'pending') {
    await sock.sendMessage(chatId, { text: `⚠️ Could not find a pending post with ID: ${id}.` });
    return;
  }

  const changes = db.cancelPost(id);
  
  if (changes > 0) {
    if (post.image_path && fs.existsSync(post.image_path)) {
      try {
        fs.unlinkSync(post.image_path);
      } catch (err) {}
    }
    const cancelMsg = `╭━━━ 🗑️ POST DELETED ━━━╮\n\nThe scheduled birthday has been successfully deleted.\n\n🆔 Post ID: #${id}\n👤 Name: ${post.name}\n📅 Date: ${post.birthday}\n\n━━━━━━━━━━━━━━━━━━\n✅ Status: Successfully Deleted`;
    await sock.sendMessage(chatId, { text: cancelMsg });
    console.log(`[Commands] Canceled post ID: ${id} and deleted image.`);
  } else {
    await sock.sendMessage(chatId, { text: `⚠️ Could not find a pending post with ID: ${id}.` });
  }
}

async function showDesignStatus(sock, chatId, argMonth) {
  let targetMonth = argMonth;
  const now = new Date();
  
  if (!targetMonth || targetMonth === 'this') {
    targetMonth = String(now.getMonth() + 1).padStart(2, '0');
  } else if (targetMonth === 'next') {
    targetMonth = String((now.getMonth() + 2) % 12 || 12).padStart(2, '0');
  } else {
    targetMonth = String(parseInt(targetMonth, 10)).padStart(2, '0');
  }

  if (targetMonth === 'NaN' || targetMonth.length !== 2) {
    return await sock.sendMessage(chatId, { text: '⚠️ *Invalid Month!*\nUse: `/status`, `/status next`, or `/status 10`' });
  }

  const submissions = db.getFormSubmissionsByMonth(`-${targetMonth}-`);
  if (submissions.length === 0) {
    return await sock.sendMessage(chatId, { text: `╭━━━ 📊 MONTHLY REPORT (Month: ${targetMonth}) ━━━╮\n\nNo form submissions found for this month.\n\n━━━━━━━━━━━━━━━━━━` });
  }

  const designed = submissions.filter(s => s.status === 'designed');
  const pending = submissions.filter(s => s.status === 'pending_design');

  let msg = `┏━━━━━━━━━━━━━━━━━━━━┓\n   📅 MONTH: ${targetMonth} SUMMARY\n┗━━━━━━━━━━━━━━━━━━━━┛\n\n`;
  
  msg += `*✅ Scheduled & Ready (${designed.length}):*\n`;
  if (designed.length > 0) {
    designed.forEach(s => { 
      const shortDate = s.birthday.split('-').slice(1).join('-'); // 09-03
      msg += `🎉 ${s.name} (${shortDate})\n`; 
    });
  } else {
    msg += `(None)\n`;
  }

  msg += `\n🔴 *PENDING DESIGNS (${pending.length})*\n`;
  if (pending.length > 0) {
    pending.forEach((s, i) => { 
      const shortDate = s.birthday.split('-').slice(1).join('-'); // 09-20
      msg += `${i + 1}. ${s.name} [${shortDate}]\n`; 
    });
  } else {
    msg += `(None! All caught up 🎉)\n`;
  }
  
  msg += `\n━━━━━━━━━━━━━━━━━━`;
  await sock.sendMessage(chatId, { text: msg });
}

module.exports = { handleCommand };