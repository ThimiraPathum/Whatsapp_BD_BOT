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
      await showTodaysBirthdays(sock, chatId);
      break;

    case '/dispatch':
      await sock.sendMessage(chatId, { text: '⚡ *Manual Dispatch Started!* Sending today\'s posts to the Main Group...' });
      if (dispatchNowFunction) {
        await dispatchNowFunction();
      } else {
        await sock.sendMessage(chatId, { text: '⚠️ Dispatch function is not ready yet.' });
      }
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

🔹 /today
View today's birthdays.

━━━━━━━━━━━━━━━━━━

🛠️ POST ACTIONS

🔹 /cancel [ID]
Delete a scheduled birthday.

Example:
/cancel 5

🔹 /dispatch
Dispatch today's birthdays to the Main Group immediately.

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

async function showTodaysBirthdays(sock, chatId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(today);

  if (todaysPosts.length === 0) {
    await sock.sendMessage(chatId, { text: `╭━━━ 🎂 TODAY'S BIRTHDAYS ━━━╮\n\n📅 ${today}\n\n━━━━━━━━━━━━━━━━━━\n\n✅ No birthdays scheduled for today.` });
    return;
  }

  let msg = `╭━━━ 🎂 TODAY'S BIRTHDAYS ━━━╮\n\n📅 ${today}\n\n━━━━━━━━━━━━━━━━━━\n\n`;
  todaysPosts.forEach(p => {
    msg += `🆔 #${p.id} — 👤 ${p.name}\n`;
  });
  
  msg += `\n━━━━━━━━━━━━━━━━━━\n\n🕛 Automatic Dispatch: 12:00 AM\n\n⚡ Use /dispatch to send today's birthdays immediately.`;

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