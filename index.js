'use strict';

/**
 * index.js — WhatsApp Birthday Bot (Baileys)
 * University of Colombo, Faculty of Technology — 22/23 Batch
 */

require('dotenv').config();

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
const { startScheduler, startDailyPreview } = require('./src/scheduler'); 
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
    const { name, birthday, photoUrl } = req.body;
    if (!name || !birthday || !photoUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    db.insertFormSubmission({ name, birthday, photoUrl });
    
    // Check if it's the current month to send an alert
    const currentMonth = new Date().toISOString().split('-')[1]; // '09'
    const submissionMonth = birthday.split('-')[1];

    if (submissionMonth === currentMonth && globalSock && process.env.REP_GROUP_ID) {
      const alertMsg = `╭━━━ 🚨 URGENT: NEW SUBMISSION ━━━╮\n\nA new birthday form was submitted for THIS MONTH!\n\n👤 Name: ${name}\n📅 Date: ${birthday}\n\n🖼️ Photo Link:\n${photoUrl}\n\n━━━━━━━━━━━━━━━━━━\nPlease design and upload the flyer ASAP.`;
      await globalSock.sendMessage(process.env.REP_GROUP_ID, { text: alertMsg });
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
  console.error('[Fatal Error] Uncaught Exception:', err);
  if (globalSock && REP_GROUP_ID) {
    try {
      await globalSock.sendMessage(REP_GROUP_ID, { 
        text: `╭━━━ 🚨 CRITICAL ERROR ━━━╮\n\nThe bot has encountered a fatal error and crashed!\n\n⚠️ *Error:*\n${err.message}\n\n━━━━━━━━━━━━━━━━━━\nBot is now restarting...` 
      });
    } catch (e) {
      console.error('[Fatal Error] Could not send WhatsApp crash alert:', e.message);
    }
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[Fatal Error] Unhandled Rejection at:', promise, 'reason:', reason);
  if (globalSock && REP_GROUP_ID) {
    try {
      // Stringify reason to avoid object [Object object]
      const reasonText = reason instanceof Error ? reason.message : String(reason);
      await globalSock.sendMessage(REP_GROUP_ID, { 
        text: `╭━━━ 🚨 CRITICAL ERROR ━━━╮\n\nThe bot has encountered an unhandled rejection and crashed!\n\n⚠️ *Reason:*\n${reasonText}\n\n━━━━━━━━━━━━━━━━━━\nBot is now restarting...` 
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });
  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.warn('⚠️  Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
      else console.error('❌ Logged out. Delete .baileys_auth and re-scan.');
    } else if (connection === 'open') {
      console.log('✅ WhatsApp client connected & ready!\n');
      console.log(`   Rep Group  : ${REP_GROUP_ID}`);
      console.log(`   Main Group : ${MAIN_GROUP_ID}\n`);

      try {
        const scheduler = startScheduler(sock, MAIN_GROUP_ID);
        global.__dispatchNow = scheduler.dispatchTodaysPosts;
        startDailyPreview(sock, REP_GROUP_ID);
      } catch (err) {
        console.error('[Scheduler] Error starting scheduler/preview:', err);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Handle emoji reactions for urgent dispatches
      if (msg.message?.reactionMessage) {
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
            db.cancelPost(reactionData.postId);
            if (post && post.image_path && fs.existsSync(post.image_path)) {
              try { fs.unlinkSync(post.image_path); } catch (e) {}
            }
            const deletedMsg = `╭━━━ 🗑️ POST DELETED ━━━╮\n\nThe birthday post has been removed from the queue.\n\n👤 Name: ${post ? post.name : 'Unknown'}\n🆔 Post ID: #${reactionData.postId}\n\n━━━━━━━━━━━━━━━━━━\n✅ Status: Deleted`;
            
            if (reactionData.originalKey) {
              await sock.sendMessage(msg.key.remoteJid, { text: deletedMsg, edit: reactionData.originalKey });
            } else {
              await sock.sendMessage(msg.key.remoteJid, { text: deletedMsg });
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
  });

  // Remove the old messages.update listener entirely
  sock.ev.on('messages.update', async (events) => {
    // Left intentionally blank as we no longer use polls
  });
}

// ─── Dispatch helper for Polls ────────────────────────────────────────────────

async function dispatchApprovedPost(sock, postId, repChatId, editKey = null) {
  const post = db.getPostById(postId);
  if (!post || post.status !== 'pending') return;

  try {
    const caption = buildCaption(post.name, post.birthday);
    await sock.sendMessage(MAIN_GROUP_ID, {
      image: fs.readFileSync(post.image_path),
      caption,
    });

    db.markCompleted(postId);

    if (fs.existsSync(post.image_path)) {
      try { fs.unlinkSync(post.image_path); } catch (e) {}
    }

    const dispatchMsg = `╭━━━ ⚡ DISPATCHED ━━━╮\n\n🎉 Birthday sent successfully to the Main Group.\n\n👤 Name: ${post.name}\n🆔 Post ID: #${postId}\n\n━━━━━━━━━━━━━━━━━━\n✅ Status: Dispatched Immediately`;
    if (editKey) {
      await sock.sendMessage(repChatId, { text: dispatchMsg, edit: editKey });
    } else {
      await sock.sendMessage(repChatId, { text: dispatchMsg });
    }
  } catch (err) {
    console.error('[Bot] Poll dispatch failed:', err);
    if (editKey) {
      await sock.sendMessage(repChatId, { text: `⚠️ Saved to DB (ID: #${postId}) but immediate dispatch failed. Will retry at midnight.`, edit: editKey });
    } else {
      await sock.sendMessage(repChatId, { text: `⚠️ Saved to DB (ID: #${postId}) but immediate dispatch failed. Will retry at midnight.` });
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
    await sock.sendMessage(chatId, { text: `📌 *Group ID:*\n${chatId}` }, { quoted: msg });
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
    const flyerMissingMsg = `╭━━━ 📸 FLYER REQUIRED ━━━╮\n\nA birthday flyer/photo is required to create a birthday post.\n\nPlease upload the flyer and use this caption:\n\n/add [Name] | [Date]\n\n💡 Example:\n/add Kasun | 2026-09-18\n\n━━━━━━━━━━━━━━━━━━\n❌ Text-only birthday posts are not accepted.`;
    await sock.sendMessage(chatId, { text: flyerMissingMsg }, { quoted: msg });
    return;
  }

  // 3. ෆොටෝ එකක් නැත්නම් මෙතනින් නතර වෙනවා
  if (!hasImage) return;

  // 4. Bot Pause කරලා තියෙනවද කියලා බලනවා
  if (db.isBotPaused()) {
    await sock.sendMessage(chatId, { text: '⚠️ *Bot is currently PAUSED.*\n\nFlyers are not being accepted right now. Type `/resume` to turn the bot back on.' }, { quoted: msg });
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
      const invalidFormatMsg = `╭━━━ ⚠️ INVALID FORMAT ━━━╮\n\nThe AI could not extract the birthday details from this flyer.\n\n📸 Please re-upload the flyer.\n\nIf the problem continues, add the following as the caption:\n\n/add [Name] | [Date]\n\n💡 Example:\n/add Kasun | 2026-09-18\n\n━━━━━━━━━━━━━━━━━━\n🔄 Please try again.`;
      await sock.sendMessage(chatId, { text: invalidFormatMsg }, { quoted: msg });
      return;
    }
    name = parts[0];
    birthday = parts[1];
  }

  console.log('[Bot] 📸 Image received in Rep Group. Downloading...');
  
  // Loading Message
  let loadingMsg;
  if (!isManualAdd) {
    loadingMsg = await sock.sendMessage(chatId, { text: '🔍 Analysing flyer with AI… please wait.' }, { quoted: msg });
  } else {
    loadingMsg = await sock.sendMessage(chatId, { text: '⚙️ Processing manual entry with Flyer...' }, { quoted: msg });
  }

  // Helper to Edit Loading Message (Prevents "Message Deleted" tombstones)
  const editLoading = async (newText) => {
    if (loadingMsg) {
      try { 
        await sock.sendMessage(chatId, { text: newText, edit: loadingMsg.key }); 
      } catch(e) {
        // Fallback if edit fails
        await sock.sendMessage(chatId, { text: newText }, { quoted: msg });
      }
    } else {
      await sock.sendMessage(chatId, { text: newText }, { quoted: msg });
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
    await editLoading('❌ Could not download the image. Please try again.');
    return;
  }

  // AI එකෙන් දත්ත ගැනීම (/add නැතිව නිකම්ම ෆොටෝ එකක් දැම්මොත්)
  if (!isManualAdd) {
    try { await sock.sendPresenceUpdate('composing', chatId); } catch (e) {}
    const details = await extractBirthdayDetails(imagePath);
    try { await sock.sendPresenceUpdate('paused', chatId); } catch (e) {}
    if (!details) {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      const aiFailedMsg = `╭━━━ ⚠️ FLYER NOT READ ━━━╮\n\nThe AI could not extract the birthday details from this flyer.\n\n📸 Please re-upload the flyer.\n\nIf the problem continues, add the following as the caption:\n\n/add [Name] | [Date]\n\n💡 Example:\n/add Kasun | 2026-09-18\n\n━━━━━━━━━━━━━━━━━━\n🔄 Please try again.`;
      await editLoading(aiFailedMsg);
      return;
    }
    name = details.name;
    birthday = details.birthday;
  }

  // Duplicate Check
  if (db.postExists({ name, birthday })) {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    const duplicateMsg = `╭━━━ ⚠️ DUPLICATE DETECTED ━━━╮\n\nA birthday with the same details already exists in the queue.\n\n👤 Name: ${name}\n📅 Date: ${birthday}\n\n━━━━━━━━━━━━━━━━━━\n🚫 No new post was created.\n\nThe existing birthday remains in the queue.`;
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
      const urgentMsg = `╭━━━ 🚨 BIRTHDAY TODAY ━━━╮\n\n👤 Name: ${name}\n🆔 Post ID: #${id}\n\n🎂 This birthday is scheduled for TODAY.\n\n━━━━━━━━━━━━━━━━━━\n\n❓ Dispatch this birthday to the Main Group now?\n\n👍 Approve & Send Immediately\n❌ Delete This Post\n\n━━━━━━━━━━━━━━━━━━\n\n⚠️ React to this message with your choice.\nThe post will not be dispatched until it is approved.`;
      
      await editLoading(urgentMsg);
      reactionCache.set(loadingMsg.key.id, { postId: id, originalKey: loadingMsg.key });
    } catch (err) {
      console.error('[Bot] Failed to send reaction message:', err);
      await editLoading(`⚠️ Saved to DB (ID: ${id}) but could not send the Poll.`);
    }
  } else {
    // අනාගත උපන්දිනයක් නම් ෂෙඩියුල් කිරීම
    const futureMsg = `╭━━━ 🎂 BIRTHDAY SCHEDULED ━━━╮\n\n👤 Name: ${name}\n📅 Date: ${birthday}\n🆔 Post ID: #${id}\n\n━━━━━━━━━━━━━━━━━━\n\n🕛 Automatic Dispatch\nScheduled for 12:00 AM on ${birthday}.\n\n✅ Status: Added to the birthday queue`;
    await editLoading(futureMsg);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('🚀 Starting WhatsApp Birthday Bot (Baileys)…');
startBot();

module.exports = { getSock: () => sock };