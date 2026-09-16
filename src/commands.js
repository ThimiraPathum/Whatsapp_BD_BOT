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
        await sock.sendMessage(chatId, { text: '⚠️ *ID එක ලබා දී නැත.*\n\nනිවැරදි භාවිතය: `/cancel [ID]`\n(ID එක බලාගැනීමට `/list` භාවිතා කරන්න).' });
        return;
      }
      await cancelPost(sock, chatId, parts[1]);
      break;

    case '/today':
      await showTodaysBirthdays(sock, chatId);
      break;

    case '/dispatch':
      await sock.sendMessage(chatId, { text: '⚡ *Manual Dispatch Started!* අද දිනට නියමිත පෝස්ට් Main Group එකට යවමින් පවතී...' });
      if (dispatchNowFunction) {
        await dispatchNowFunction();
      } else {
        await sock.sendMessage(chatId, { text: '⚠️ Dispatch function is not ready yet.' });
      }
      break;

    default:
      if (cmd !== '/add' && cmd !== '/id') {
          // /add සහ /id index.js හි හසුරුවන බැවින් මෙහිදී ප්රතික්ෂේප නොකෙරේ.
          await sock.sendMessage(chatId, { text: '❓ *වැරදි Command එකක්!*\nඋදව් සඳහා `/help` ටයිප් කරන්න.' });
      }
      break;
  }
}

async function showHelpMenu(sock, chatId) {
  const menu = `
🤖 *Birthday Bot Commands* 🤖

🔹 */add [නම] | [දිනය]*
(පින්තූරයක් සමඟ පමණි) AI එකට කියවගන්න බැරි වුණොත්, Flyer එක යවන ගමන් ඒකේ Caption එකට මේ කමාන්ඩ් එක දාලා අතින් ෂෙඩියුල් කරන්න.
උදා: \`/add Kasun | 2026-09-18\`

🔹 */list* හෝ */pending*
ඉදිරියට ෂෙඩියුල් කර ඇති සියලුම උපන්දින බලාගන්න.

🔹 */today*
අද දිනට නියමිත උපන්දින ලැයිස්තුව බලාගන්න.

🔹 */cancel [ID]*
වැරදිලා ෂෙඩියුල් වුණු පෝස්ට් එකක් මකා දමන්න.
උදා: \`/cancel 5\`

🔹 */dispatch*
අද දිනට නියමිත පෝස්ට් රෑ 12 වෙනකන් ඉන්නේ නැතුව දැන්ම Main Group එකට යවන්න (Manual trigger).

🔹 */id*
ඔබ සිටින Group එකේ ID එක ලබාගන්න.
`;
  await sock.sendMessage(chatId, { text: menu.trim() });
}

async function listPendingPosts(sock, chatId) {
  const pending = db.listPending();
  
  if (pending.length === 0) {
    await sock.sendMessage(chatId, { text: '✅ දැනට කිසිදු පෝස්ට් එකක් ෂෙඩියුල් කර නොමැත.' });
    return;
  }

  let msg = '📅 *Upcoming Birthdays (Pending):*\n\n';
  pending.forEach(p => {
    msg += `🆔 ID: ${p.id}\n👤 නම: ${p.name}\n📆 දිනය: ${p.birthday}\n\n`;
  });

  await sock.sendMessage(chatId, { text: msg.trim() });
}

async function showTodaysBirthdays(sock, chatId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(today);

  if (todaysPosts.length === 0) {
    await sock.sendMessage(chatId, { text: `📅 *අද (${today})*\n\nඅද දිනට කිසිදු උපන්දිනයක් ෂෙඩියුල් කර නොමැත.` });
    return;
  }

  let msg = `📅 *අද දිනට නියමිත උපන්දින (${today}):*\n\n`;
  todaysPosts.forEach(p => {
    msg += `🆔 ID: ${p.id} - ${p.name}\n`;
  });
  
  msg += `\n_මේවා අද රාත්රී 12:00 ට (හෝ /dispatch මගින්) Main Group එකට යැවෙනු ඇත._`;

  await sock.sendMessage(chatId, { text: msg.trim() });
}

async function cancelPost(sock, chatId, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await sock.sendMessage(chatId, { text: '⚠️ *අවලංගු ID එකක්!* කරුණාකර නිවැරදි අංකය ලබා දෙන්න.' });
    return;
  }

  const post = db.getPostById(id);
  if (!post || post.status !== 'pending') {
    await sock.sendMessage(chatId, { text: `⚠️ ID: ${id} සහිත Pending පෝස්ට් එකක් සොයාගැනීමට නොහැකි විය.` });
    return;
  }

  const changes = db.cancelPost(id);
  
  if (changes > 0) {
    if (post.image_path && fs.existsSync(post.image_path)) {
      try {
        fs.unlinkSync(post.image_path);
      } catch (err) {}
    }
    await sock.sendMessage(chatId, { text: `🗑️ *පෝස්ට් එක සාර්ථකව මකා දමන ලදී!*\n\n🆔 ID: ${id}\n👤 නම: ${post.name}\n📅 දිනය: ${post.birthday}` });
    console.log(`[Commands] Canceled post ID: ${id} and deleted image.`);
  } else {
    await sock.sendMessage(chatId, { text: `⚠️ ID: ${id} සහිත Pending පෝස්ට් එකක් සොයාගැනීමට නොහැකි විය.` });
  }
}

module.exports = { handleCommand };