'use strict';

const { sendRepMessage } = require('./src/rep-messages');
const { card, formatDate, postDetails } = require('./src/message-layout');

/**
 * index.js — WhatsApp Birthday Bot (Baileys)
 * University of Colombo, Faculty of Technology — 22/23 Batch
 */

require('dotenv').config();
require('./src/safe-logging').protectSessionLogs();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const db = require('./src/database');
const { createManager } = require('./src/reliability');
const { createConnectionManager } = require('./src/connection-manager');
const { handleCommand } = require('./src/commands');
const { extractBirthdayDetails } = require('./src/vision');

// ─── Uptime Monitor & Health Check Server ───────────────────────────────────
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.post('/api/submit-form', async (req, res) => {
  try {
    let { name, birthday, photoUrl } = req.body;
    if (!name || !birthday || !photoUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Clean dirty dates (e.g., 2003-09-03T18:00:00.000Z -> 2003-09-03)
    if (birthday.includes('T')) {
      birthday = birthday.split('T')[0];
    }
    
    // Ensure the year is the upcoming year
    const now = new Date();
    const parts = birthday.split('-');
    if (parts.length === 3) {
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      let upcomingYear = now.getFullYear();
      if (new Date(upcomingYear, month, day) < now) {
        upcomingYear += 1;
      }
      birthday = `${upcomingYear}-${parts[1]}-${parts[2]}`;
    }

    db.insertFormSubmission({ name, birthday, photoUrl });
    
    // Check if it's the current month to send an alert
    const currentMonth = new Date().toISOString().split('-')[1]; // '09'
    const submissionMonth = birthday.split('-')[1];

    if (submissionMonth === currentMonth && connection.getSocket() && process.env.REP_GROUP_ID) {
      const alertMsg = card('📥 අලුත් උපන්දින Form එකක් ලැබුණා', postDetails(name, birthday), '*මේ මාසයේ උපන්දිනයකි*\nහැකි ඉක්මනින් ෆ්ලයර් එක නිර්මාණය කර upload කරන්න.', `📷 *ඡායාරූපය*\n${photoUrl}`);
      await sendRepMessage(connection.getSocket(), process.env.REP_GROUP_ID, { text: alertMsg });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Web] Form submission error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`[Monitor] Uptime server running on port ${PORT}`);
});

// ─── Global Error Handlers (WhatsApp Crash Alerts) ──────────────────────────
let globalSock = null; // Used to send crash messages

process.on('uncaughtException', async (err) => {
  console.error('[Fatal Error] Uncaught exception; process will exit');
  if (globalSock && REP_GROUP_ID) {
    try {
      await sendRepMessage(globalSock, REP_GROUP_ID, {
        text: card('🚨 Bot ක්‍රියාකාරීත්වයේ දෝෂයක්', 'බරපතළ දෝෂයක් නිසා Bot නතර වෙමින් පවතී.', `*දෝෂය*\n${err.message}`, 'පරිපාලකයා දැනුවත් කරන්න. Server logs පරීක්ෂා කළ යුතුය. ස්වයංක්‍රීය restart සකසා ඇත්නම් PM2 මඟින් නැවත ආරම්භ වේ.')
      });
    } catch (e) {
      console.error('[Fatal Error] Could not send WhatsApp crash alert:', e.message);
    }
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[Fatal Error] Unhandled rejection; process will exit');
  if (globalSock && REP_GROUP_ID) {
    try {
      // Stringify reason to avoid object [Object object]
      const reasonText = reason instanceof Error ? reason.message : String(reason);
      await sendRepMessage(globalSock, REP_GROUP_ID, {
        text: card('🚨 Bot ක්‍රියාකාරීත්වයේ දෝෂයක්', 'හැසිරවිය නොහැකි දෝෂයක් නිසා Bot නතර වෙමින් පවතී.', `*හේතුව*\n${reasonText}`, 'පරිපාලකයා දැනුවත් කරන්න. Server logs පරීක්ෂා කළ යුතුය. ස්වයංක්‍රීය restart සකසා ඇත්නම් PM2 මඟින් නැවත ආරම්භ වේ.')
      });
    } catch (e) {
      console.error('[Fatal Error] Could not send WhatsApp crash alert:', e.message);
    }
  }
  process.exit(1);
});

// ─── Config validation ────────────────────────────────────────────────────────

const REQUIRED_ENV = ['GROQ_API_KEY', 'REP_GROUP_ID', 'MAIN_GROUP_ID'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const REP_GROUP_ID = process.env.REP_GROUP_ID.trim();
const MAIN_GROUP_ID = process.env.MAIN_GROUP_ID.trim();
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

const reactionCache = new Map(); // Cache for reaction messages


// ─── Caption Builder Helper ───────────────────────────────────────────────────

function buildCaption(name, birthday) {
  const parts = name.trim().split(/\s+/);
  let firstName = parts[0];

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

  return template.replace(/\{name\}/gi, firstName).replace(/\{date\}/gi, birthday);
}

// ─── Baileys connection ───────────────────────────────────────────────────────

let sock;

const connection = createConnectionManager({
  loggedOutCode: DisconnectReason.loggedOut,
  createSocket: async () => {
    const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');
    return { socket: makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) }), saveCreds };
  },
  onUpdate: ({ qr }) => { if (qr) qrcode.generate(qr, { small: true }); },
  onReady: async (activeSocket) => { sock = activeSocket; globalSock = activeSocket; await schedulerManager.check(); },
  onMessage: async (activeSocket, { messages, type }) => {
    sock = activeSocket;
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Handle emoji reactions for urgent dispatches
      if (msg.message?.reactionMessage) {
        if (msg.key.remoteJid !== REP_GROUP_ID || msg.key.fromMe) continue;
        const reaction = msg.message.reactionMessage;
        const reactedMsgId = reaction.key.id;
        const emoji = reaction.text;

        const reactionData = reactionCache.get(reactedMsgId);
        if (reactionData) {
          if (emoji === '👍') {
            console.log(`[Bot] Reaction approved for ID: ${reactionData.postId}`);
            reactionCache.delete(reactedMsgId);
            await dispatchApprovedPost(sock, reactionData.postId, msg.key.remoteJid, reactionData.originalKey);
          } else if (emoji === '❌') {
            console.log(`[Bot] Reaction canceled for ID: ${reactionData.postId}`);
            reactionCache.delete(reactedMsgId);
            
            const post = db.getPostById(reactionData.postId);
            if (!db.cancelPost(reactionData.postId)) continue;
            if (post && post.image_path && fs.existsSync(post.image_path)) {
              try { fs.unlinkSync(post.image_path); } catch (e) {}
            }
            const deletedMsg = card('🗑️ පෝස්ටුව අවලංගු කළා', postDetails(post ? post.name : 'නම නොදනී', post?.birthday, reactionData.postId), 'යැවීමේ ලැයිස්තුවෙන් ඉවත් කළා. මෙම පෝස්ටුව යැවෙන්නේ නැත.');
            
            if (reactionData.originalKey) {
              await sendRepMessage(sock, msg.key.remoteJid, { text: deletedMsg, edit: reactionData.originalKey });
            } else {
              await sendRepMessage(sock, msg.key.remoteJid, { text: deletedMsg });
            }
          }
        }
        continue; // Skip further processing for reactions
      }

      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        console.error('[Bot] Unhandled error in message handler:', err);
      }
    }
  },
});
const schedulerManager = createManager({ db, getSocket: connection.getSocket,
  mainGroupId: MAIN_GROUP_ID, repGroupId: REP_GROUP_ID, timezone: TIMEZONE,
  adminAlertJid: process.env.ADMIN_ALERT_JID?.trim(),
  updateNoticeAt: process.env.UPDATE_NOTICE_AT?.trim(),
  dispatchWindowMinutes: Number(process.env.DISPATCH_RECOVERY_MINUTES || 120),
  previewWindowMinutes: Number(process.env.PREVIEW_RECOVERY_MINUTES || 180) });
global.__dispatchNow = schedulerManager.dispatchTodaysPosts;
async function startBot() { schedulerManager.start(); await connection.start(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  schedulerManager.stop(); connection.stop();
  await Promise.race([schedulerManager.drain(), new Promise(resolve => setTimeout(resolve, 5000))]);
  process.exit(0);
});
// Health details require a secret bearer token; never expose session information.
app.get('/health', (req, res) => {
  const token = process.env.HEALTH_TOKEN;
  if (!token || req.headers.authorization !== 'Bearer ' + token) return res.sendStatus(401);
  res.json(schedulerManager.health());
});

// ─── Dispatch helper for Polls ────────────────────────────────────────────────

async function dispatchApprovedPost(sock, postId, repChatId, editKey = null) {
  const post = db.getPostById(postId);
  if (!post || post.status !== 'pending') return;

  try {
    if (!await schedulerManager.sendPost(postId)) throw new Error('Delivery needs review or is paused');

    const dispatchMsg = card('✅ උපන්දින පෝස්ටුව යැවුවා', postDetails(post.name, post.birthday, postId), 'Main Group එකට සාර්ථකව යැවුවා.');
    if (editKey) {
      await sendRepMessage(sock, repChatId, { text: dispatchMsg, edit: editKey });
    } else {
      await sendRepMessage(sock, repChatId, { text: dispatchMsg });
    }
  } catch (err) {
    console.error('[Bot] Poll dispatch failed:', err);
    const failureMsg = card('⚠️ යැවීම තහවුරු කළ නොහැක', `🆔 Post #${postId}`, 'දැන්ම යැවීම සම්පූර්ණ වූ බව තහවුරු කළ නොහැක. නැවත උත්සාහ කිරීමට පෙර පෝස්ටුවේ තත්ත්වය සහ connection එක පරීක්ෂා කරන්න.', 'යැවීමට ඉතිරි පෝස්ටු බැලීමට: `/list`');
    if (editKey) {
      await sendRepMessage(sock, repChatId, { text: failureMsg, edit: editKey });
    } else {
      await sendRepMessage(sock, repChatId, { text: failureMsg });
    }
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleIncomingMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  // Mark message as read (Blue Ticks)
  try {
    await sock.readMessages([msg.key]);
  } catch (err) {}

  const chatId = msg.key.remoteJid;
  const body =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    '';

  if (body.trim() === '/id') {
    await sendRepMessage(sock, chatId, { text: card('📌 මෙම chat එකේ ID', chatId) }, { quoted: msg });
    return;
  }

  if (chatId !== REP_GROUP_ID) return;

  const hasImage = !!msg.message.imageMessage;
  const trimmed = body.trim();

  // 1. අනිත් Commands (/list, /cancel ආදිය - මේවාට ෆොටෝ අවශ්ය නැත)
  if (trimmed.startsWith('/') && !trimmed.startsWith('/add')) {
    await handleCommand(sock, chatId, trimmed, global.__dispatchNow);
    return;
  }

  // 2. ෆොටෝ එකක් නැතුව නිකම්ම /add ගැහුවොත් බ්ලොක් කිරීම
  if (trimmed.startsWith('/add') && !hasImage) {
    const flyerMissingMsg = card('📸 ෆ්ලයර් එක අවශ්‍යයි', 'ෆ්ලයර් ඡායාරූපය සමඟ නම සහ උපන්දිනය caption එකේ යොදන්න.', '*Caption උදාහරණය*\n`/add Kasun Perera | 2026-10-20`', 'උදාහරණය වෙනුවට නිවැරදි නම සහ දිනය යොදන්න. ඡායාරූපයක් නොමැතිව පෝස්ටුවක් ඇතුළත් කළ නොහැක.');
    await sendRepMessage(sock, chatId, { text: flyerMissingMsg }, { quoted: msg });
    return;
  }

  // 3. ෆොටෝ එකක් නැත්නම් මෙතනින් නතර වෙනවා
  if (!hasImage) return;

  // 4. Bot Pause කරලා තියෙනවද කියලා බලනවා
  if (db.isBotPaused()) {
    await sendRepMessage(sock, chatId, { text: card('⏸️ Bot තාවකාලිකව නවතා ඇත', 'මෙම ෆ්ලයර් එක පෝස්ටුවක් ලෙස ඇතුළත් කර නැත.', '*ඊළඟ පියවර*\n`/resume` භාවිත කර ෆ්ලයර් එක නැවත upload කරන්න.') }, { quoted: msg });
    return;
  }

  // ==========================================
  // මෙතැන් සිට පහළට යන්නේ ෆොටෝ (Flyers) පමණි!
  // ==========================================

  let name, birthday;
  const isManualAdd = trimmed.startsWith('/add');

  // Manual Override (ෆොටෝ එකේ කැප්ෂන් එකට /add ගහලා නම්)
  if (isManualAdd) {
    const content = trimmed.replace('/add', '').trim();
    const parts = content.split('|').map((p) => p.trim());
    if (parts.length < 2) {
      const invalidFormatMsg = card('⚠️ Caption ආකාරය වැරදියි', 'නම සහ දිනය අතර `|` යොදා ෆ්ලයර් එක නැවත upload කරන්න.', '*Caption උදාහරණය*\n`/add Kasun Perera | 2026-10-20`', 'උදාහරණය වෙනුවට නිවැරදි නම සහ දිනය යොදන්න. දිනය YYYY-MM-DD ආකාරයට සඳහන් කරන්න.');
      await sendRepMessage(sock, chatId, { text: invalidFormatMsg }, { quoted: msg });
      return;
    }
    name = parts[0];
    birthday = parts[1];
  }

  console.log('[Bot] 📸 Image received in Rep Group. Downloading...');
  
  // Loading Message
  let loadingMsg;
  if (!isManualAdd) {
    loadingMsg = await sendRepMessage(sock, chatId, { text: card('🔍 ෆ්ලයර් එක පරීක්ෂා කෙරේ', 'ෆ්ලයර් එකේ සඳහන් නම සහ උපන්දිනය කියවමින් පවතී…') }, { quoted: msg });
  } else {
    loadingMsg = await sendRepMessage(sock, chatId, { text: card('⚙️ පෝස්ටුව ඇතුළත් කරමින් පවතී', 'ෆ්ලයර් එක සහ caption එකේ සඳහන් තොරතුරු සුරකිමින් පවතී…') }, { quoted: msg });
  }

  // Helper to Edit Loading Message (Prevents "Message Deleted" tombstones)
  const editLoading = async (newText) => {
    if (loadingMsg) {
      try { 
        await sendRepMessage(sock, chatId, { text: newText, edit: loadingMsg.key });
      } catch(e) {
        // Fallback if edit fails
        await sendRepMessage(sock, chatId, { text: newText }, { quoted: msg });
      }
    } else {
      await sendRepMessage(sock, chatId, { text: newText }, { quoted: msg });
    }
  };

  // ෆොටෝ එක Download කිරීම
  let imagePath;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
    const uploadDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    imagePath = path.join(uploadDir, `birthday_${Date.now()}.jpg`);
    fs.writeFileSync(imagePath, buffer);
    console.log(`[Bot] ✅ Image downloaded to: ${imagePath}`);
  } catch (err) {
    console.error('[Bot] Download failed:', err.message);
    await editLoading(card('⚠️ ඡායාරූපය ලබාගත නොහැක', 'උපන්දින පෝස්ටුව ඇතුළත් කර නැත.', '*ඊළඟ පියවර*\nෆ්ලයර් ඡායාරූපය නැවත upload කරන්න.'));
    return;
  }

  // AI එකෙන් දත්ත ගැනීම (/add නැතිව නිකම්ම ෆොටෝ එකක් දැම්මොත්)
  if (!isManualAdd) {
    try { await sock.sendPresenceUpdate('composing', chatId); } catch (e) {}
    const details = await extractBirthdayDetails(imagePath);
    try { await sock.sendPresenceUpdate('paused', chatId); } catch (e) {}
    if (!details || (details.status && details.status !== 'OK' && details.status !== 'IGNORE')) {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      const aiFailedMsg = card('⚠️ ෆ්ලයර් එක කියවාගත නොහැක', 'මෙහි නම හෝ උපන්දිනය නිවැරදිව හඳුනාගැනීමට නොහැකි විය. පෝස්ටුව ඇතුළත් කර නැත.', '*ඊළඟ පියවර*\nපහත ආකාරයට caption එකක් සමඟ ෆ්ලයර් එක නැවත upload කරන්න:', '`/add Kasun Perera | 2026-10-20`\nඋදාහරණය වෙනුවට නිවැරදි නම සහ දිනය (YYYY-MM-DD) යොදන්න.');
      await editLoading(aiFailedMsg);
      return;
    }
    
    if (details.status === 'IGNORE') {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      await editLoading(card('📷 මෙය සාමාන්‍ය ඡායාරූපයකි', 'මෙය නිම කළ උපන්දින ෆ්ලයර් එකක් නොවන බැවින් පෝස්ටුවක් ලෙස ඇතුළත් කර නැත.', '*ඊළඟ පියවර*\nඋපන්දින ෆ්ලයර් එක නිර්මාණය කර අවසන් වූ පසු නැවත upload කරන්න.'));
      return;
    }

    name = details.name;
    birthday = details.birthday;
  }

  // Duplicate Check
  if (db.postExists({ name, birthday })) {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    const duplicateMsg = card('👀 මෙම උපන්දිනය දැනටමත් ඇතුළත් කර ඇත', postDetails(name, birthday), 'මෙම නම සහ දිනයට ගැළපෙන පෝස්ටුවක් දැනටමත් ඇත. නැවත ඇතුළත් කර නැත.', 'යැවීමට ඉතිරි පෝස්ටු බැලීමට: `/list`');
    await editLoading(duplicateMsg);
    return;
  }

  // ඩේටාබේස් එකට ඇතුළත් කිරීම
  const id = db.insertPost({
    name,
    birthday,
    imagePath,
    msgId: msg.key.id,
    chatId,
  });

  // Late Dispatch (අද දවසේ උපන්දිනයක් නම්)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD

  if (birthday === today) {
    try {
      const urgentMsg = card('🎂 අද උපන්දිනයකි — අනුමැතිය අවශ්‍යයි', `👤 *${name.trim()}*\n📅 ${formatDate(birthday)} (අද)\n📍 Main Group · Post #${id}`, '*මෙය දැන්ම Main Group එකට යවන්නද?*\n👍 — දැන්ම යවන්න\n❌ — පෝස්ටුව අවලංගු කරන්න', 'තෝරාගැනීමට මෙම පණිවිඩයට react කරන්න. ඔබ අනුමත කරන තෙක් මෙය නොයවනු ඇත.');
      
      await editLoading(urgentMsg);
      reactionCache.set(loadingMsg.key.id, { postId: id, originalKey: loadingMsg.key });
    } catch (err) {
      console.error('[Bot] Failed to send reaction message:', err);
      await editLoading(card('⚠️ අනුමැතිය ඉල්ලා සිටිය නොහැකි විය', `උපන්දිනය #${id} පෝස්ටුව ලෙස සුරැකී ඇත.`, 'නැවත upload කිරීමට පෙර `/list` පරීක්ෂා කර පරිපාලකයා දැනුවත් කරන්න.'));
    }
  } else {
    // අනාගත උපන්දිනයක් නම් ෂෙඩියුල් කිරීම
    const futureMsg = card('🎂 උපන්දින පෝස්ටුව සූදානම්',
      `👤 *${name.trim()}*\n📅 ${formatDate(birthday)} · 12:00 AM (${TIMEZONE === 'Asia/Colombo' ? 'SL Time' : TIMEZONE})\n📍 Main Group · Post #${id}`,
      '✅ සාර්ථකව ඇතුළත් කළා. නියමිත දින රාත්‍රී 12:00 ට ස්වයංක්‍රීයව Main Group එකට යැවේ.',
      `ඉවත් කිරීමට: \`/cancel ${id}\``
    );
    await editLoading(futureMsg);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('🚀 Starting WhatsApp Birthday Bot (Baileys)…');
startBot();

module.exports = { getSock: () => sock };
