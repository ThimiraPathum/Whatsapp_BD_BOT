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
  const menu = `
🤖 *Birthday Bot Commands* 🤖

🔹 */add [Name] | [Date]*
(With photo only) If AI fails to extract details, add this command as the caption of the flyer.
Ex: \`/add Kasun | 2026-09-18\`

🔹 */list* or */pending*
View all upcoming scheduled birthdays.

🔹 */today*
View today's scheduled birthdays.

🔹 */cancel [ID]*
Delete a scheduled post by ID.
Ex: \`/cancel 5\`

🔹 */dispatch*
Manually dispatch today's posts to the Main Group immediately.

🔹 */id*
Get the current Group ID.
`;
  await sock.sendMessage(chatId, { text: menu.trim() });
}

async function listPendingPosts(sock, chatId) {
  const pending = db.listPending();
  
  if (pending.length === 0) {
    await sock.sendMessage(chatId, { text: '✅ No posts are currently scheduled.' });
    return;
  }

  let msg = '📅 *Upcoming Birthdays (Pending):*\n\n';
  pending.forEach(p => {
    msg += `🆔 ID: ${p.id}\n👤 Name: ${p.name}\n📆 Date: ${p.birthday}\n\n`;
  });

  await sock.sendMessage(chatId, { text: msg.trim() });
}

async function showTodaysBirthdays(sock, chatId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(today);

  if (todaysPosts.length === 0) {
    await sock.sendMessage(chatId, { text: `📅 *Today (${today})*\n\nNo birthdays scheduled for today.` });
    return;
  }

  let msg = `📅 *Today's Birthdays (${today}):*\n\n`;
  todaysPosts.forEach(p => {
    msg += `🆔 ID: ${p.id} - ${p.name}\n`;
  });
  
  msg += `\n_These will be dispatched to the Main Group tonight at 12:00 AM (or via /dispatch)._`;

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
    await sock.sendMessage(chatId, { text: `🗑️ *Post successfully deleted!*\n\n🆔 ID: ${id}\n👤 Name: ${post.name}\n📅 Date: ${post.birthday}` });
    console.log(`[Commands] Canceled post ID: ${id} and deleted image.`);
  } else {
    await sock.sendMessage(chatId, { text: `⚠️ Could not find a pending post with ID: ${id}.` });
  }
}

module.exports = { handleCommand };