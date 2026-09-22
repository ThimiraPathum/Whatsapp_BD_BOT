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

🎂 BIRTHDAY MANAGEMENT

🔹 /add [Name] | [Date]
Add a birthday using a flyer.

📸 Photo required

Use this caption if the AI cannot read the flyer.

Example:
/add Kasun | 2026-09-18

━━━━━━━━━━━━━━━━━━

📋 VIEW BIRTHDAYS

🔹 /list or /pending
View all upcoming birthdays.

🔹 /today or /tonight
View birthdays scheduled for tonight's dispatch.

━━━━━━━━━━━━━━━━━━

🛠️ POST ACTIONS

🔹 /cancel [ID]
Delete a scheduled birthday.

Example:
/cancel 5

🔹 /dispatch
Manually dispatch tonight's birthdays to the Main Group immediately.

━━━━━━━━━━━━━━━━━━

ℹ️ BOT INFORMATION

🔹 /id
Get the current Group ID.

━━━━━━━━━━━━━━━━━━

🤖 Birthday Bot
Your automated birthday scheduling assistant.`;
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

module.exports = { handleCommand };