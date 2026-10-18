'use strict';

const { sendRepMessage } = require('./src/rep-messages');
const { card, formatDate, postDetails, SEPARATOR } = require('./src/message-layout');

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

    if (submissionMonth === currentMonth && globalSock && process.env.REP_GROUP_ID) {
      const alertMsg = card('📥 New birthday form', postDetails(name, birthday), '*This month’s birthday*\nPlease design and upload the flyer as soon as possible.', `📷 *Photo*\n${photoUrl}`);
      await sendRepMessage(globalSock, process.env.REP_GROUP_ID, { text: alertMsg });
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
      await sendRepMessage(globalSock, REP_GROUP_ID, {
        text: card('🚨 Critical error', 'The bot encountered a fatal error and is stopping.', `*Error*\n${err.message}`, 'Check the server logs. PM2 will restart the bot if configured to do so.')
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
      await sendRepMessage(globalSock, REP_GROUP_ID, {
        text: card('🚨 Critical error', 'The bot encountered an unhandled error and is stopping.', `*Reason*\n${reasonText}`, 'Check the server logs. PM2 will restart the bot if configured to do so.')
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
            const deletedMsg = card('🗑️ Post cancelled', postDetails(post ? post.name : 'Unknown', post?.birthday, reactionData.postId), 'Removed from the queue. This post will not be sent.');
            
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

    const dispatchMsg = card('✅ Birthday sent', postDetails(post.name, post.birthday, postId), 'Delivered to the Main Group.');
    if (editKey) {
      await sendRepMessage(sock, repChatId, { text: dispatchMsg, edit: editKey });
    } else {
      await sendRepMessage(sock, repChatId, { text: dispatchMsg });
    }
  } catch (err) {
    console.error('[Bot] Poll dispatch failed:', err);
    const failureMsg = card('⚠️ Dispatch failed', `🆔 Post #${postId}`, 'The immediate send could not be completed. Check the post status and connection before retrying.', 'View pending posts: `/list`');
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
    await sendRepMessage(sock, chatId, { text: card('📌 Chat ID', chatId) }, { quoted: msg });
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
    const flyerMissingMsg = card('📸 Flyer required', 'Attach the flyer image and add the name and birthday in its caption.', '*Caption example*\n`/add Kasun Perera | 2026-10-20`', 'Replace the example name and date. Text-only posts cannot be scheduled.');
    await sendRepMessage(sock, chatId, { text: flyerMissingMsg }, { quoted: msg });
    return;
  }

  // 3. ෆොටෝ එකක් නැත්නම් මෙතනින් නතර වෙනවා
  if (!hasImage) return;

  // 4. Bot Pause කරලා තියෙනවද කියලා බලනවා
  if (db.isBotPaused()) {
    await sendRepMessage(sock, chatId, { text: card('⏸️ Bot is currently paused', 'This flyer has not been scheduled.', '*Next step*\nUse `/resume`, then upload the flyer again.') }, { quoted: msg });
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
      const invalidFormatMsg = card('⚠️ Invalid caption format', 'Upload the flyer again with the name and date separated by `|`.', '*Caption example*\n`/add Kasun Perera | 2026-10-20`', 'Replace the example name and date. Use YYYY-MM-DD for the date.');
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
    loadingMsg = await sendRepMessage(sock, chatId, { text: card('🔍 Analysing flyer', 'Reading the name and birthday date…') }, { quoted: msg });
  } else {
    loadingMsg = await sendRepMessage(sock, chatId, { text: card('⚙️ Processing manual entry', 'Saving your flyer and caption details…') }, { quoted: msg });
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
    await editLoading(card('⚠️ Could not download image', 'The birthday has not been scheduled.', '*Next step*\nUpload the image again.'));
    return;
  }

  // AI එකෙන් දත්ත ගැනීම (/add නැතිව නිකම්ම ෆොටෝ එකක් දැම්මොත්)
  if (!isManualAdd) {
    try { await sock.sendPresenceUpdate('composing', chatId); } catch (e) {}
    const details = await extractBirthdayDetails(imagePath);
    try { await sock.sendPresenceUpdate('paused', chatId); } catch (e) {}
    if (!details || (details.status && details.status !== 'OK' && details.status !== 'IGNORE')) {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      const aiFailedMsg = card('⚠️ Could not read flyer', 'The name or birthday date could not be read. Nothing has been scheduled.', '*Next step*\nUpload the flyer again with this caption:', '`/add Kasun Perera | 2026-10-20`\nReplace the example with the correct name and date.');
      await editLoading(aiFailedMsg);
      return;
    }
    
    if (details.status === 'IGNORE') {
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      await editLoading(card('📷 Raw photo detected', 'This looks like a regular photo. No birthday post was scheduled.', 'Upload the completed birthday flyer when it is ready.'));
      return;
    }

    name = details.name;
    birthday = details.birthday;
  }

  // Duplicate Check
  if (db.postExists({ name, birthday })) {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    const duplicateMsg = card('👀 Already scheduled', postDetails(name, birthday), 'A matching birthday is already in the queue. No duplicate was added.', 'View the queue: `/list`');
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
      const urgentMsg = card('🎂 Birthday today', postDetails(name, birthday, id), '*Send to the Main Group now?*\n👍 Send now\n❌ Cancel this post', 'React to this message to choose. Approval is needed for immediate sending.');
      
      await editLoading(urgentMsg);
      reactionCache.set(loadingMsg.key.id, { postId: id, originalKey: loadingMsg.key });
    } catch (err) {
      console.error('[Bot] Failed to send reaction message:', err);
      await editLoading(card('⚠️ Could not request approval', `The birthday was saved as post #${id}.`, 'Check `/list` before uploading again.'));
    }
  } else {
    // අනාගත උපන්දිනයක් නම් ෂෙඩියුල් කිරීම
    const futureMsg = card('🎂 Birthday confirmed',
      `*${name.trim()}* ✨`,
      `📅  ${formatDate(birthday, 'long')}\n🕛  12:00 AM · ${TIMEZONE === 'Asia/Colombo' ? 'Sri Lanka' : TIMEZONE}\n📍  Main Group`,
      '✅ Saved and ready for automatic sending.',
      `${SEPARATOR}\nPOST #${id}  •  Cancel: \`/cancel ${id}\``
    );
    await editLoading(futureMsg);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('🚀 Starting WhatsApp Birthday Bot (Baileys)…');
startBot();

module.exports = { getSock: () => sock };
