'use strict';

const { sendRepMessage } = require('./rep-messages');
const { card, formatDate, postDetails } = require('./message-layout');

const db = require('./database');
const fs = require('fs');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';
const TIMEZONE_LABEL = TIMEZONE === 'Asia/Colombo' ? 'Sri Lanka time' : TIMEZONE;

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
        await sendRepMessage(sock, chatId, { text: card('⚠️ Post ID not provided', 'Choose a post with `/list`, then use its ID.', '*Example*\n`/cancel 18`') });
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
        const msgKey = await sendRepMessage(sock, chatId, { text: card('⏳ Sending birthday posts', 'Sending tonight’s posts to the Main Group now…') });
        if (dispatchNowFunction) {
          const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
          const count = await dispatchNowFunction(tomorrow);
          await sendRepMessage(sock, chatId, { text: card('✅ Dispatch complete', `📅 ${formatDate(tomorrow)}\n📤 *Sent to Main Group: ${count || 0}*`, 'Successfully sent posts will not be sent again at midnight.'), edit: msgKey.key });
        } else {
          await sendRepMessage(sock, chatId, { text: card('⏳ Dispatch not ready', 'Please wait a moment and try `/dispatch` again.\nNo posts were sent.'), edit: msgKey.key });
        }
      }
      break;

    case '/pause':
      db.setBotPaused(true);
      await sendRepMessage(sock, chatId, { text: card('⏸️ Bot paused', '📸 Flyer uploads are paused.\n🕛 Scheduled sending is paused.', 'Use `/resume` to continue.') });
      break;

    case '/clear-form':
      db.clearFormSubmissions();
      await sendRepMessage(sock, chatId, { text: card('🧹 Form entries cleared', 'All form submissions have been cleared, including completed designs.\nBirthday posts have not been removed.', 'You can now sync the form data from Google Sheets again.') });
      break;

    case '/resume':
      db.setBotPaused(false);
      await sendRepMessage(sock, chatId, { text: card('▶️ Bot resumed', '📸 Ready for new flyers.\n🕛 Scheduled sending is active.') });
      break;

    default:
      if (cmd !== '/add' && cmd !== '/id') {
          await sendRepMessage(sock, chatId, { text: card('❓ Invalid command', 'Use `/help` to see the available commands.') });
      }
      break;
  }
}

async function showHelpMenu(sock, chatId) {
  const menu = card('🤖 Command guide',
    '*📊 Design progress*\n`/status` — This month\n`/status next` — Next month\n`/status 10` — October',
    '*📸 Add a birthday*\nUpload a finished flyer.\nIf AI cannot read it, upload it again with this caption:\n`/add Kasun Perera | 2026-10-20`\n\nUse the correct name and date. A flyer image is required.',
    '*📋 View posts*\n`/list` or `/pending` — All posts waiting to be sent\n`/tonight` or `/today` — Upcoming midnight’s posts',
    '*🛠️ Manage posts*\n`/cancel 18` — Remove post #18\n`/dispatch` — Send tonight’s posts immediately',
    '*⏯️ Bot controls*\n`/pause` — Pause uploads and sending\n`/resume` — Resume both',
    `🕛 All times: ${TIMEZONE_LABEL}`
  );
  await sendRepMessage(sock, chatId, { text: menu });
}

async function listPendingPosts(sock, chatId) {
  const pending = db.listPending();
  
  if (pending.length === 0) {
    await sendRepMessage(sock, chatId, { text: card('📋 Birthday queue', 'No posts are waiting to be sent.', 'Upload a birthday flyer to add a post.') });
    return;
  }

  const msg = card('📋 Birthday queue',
    `*Waiting to be sent: ${pending.length}*`,
    ...pending.map(p => postDetails(p.name, p.birthday, p.id)),
    `🕛 Scheduled for 12:00 AM · ${TIMEZONE_LABEL}\nTo remove a post: \`/cancel [ID]\``
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

async function showTonightBirthdays(sock, chatId) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(tomorrow);

  if (todaysPosts.length === 0) {
    await sendRepMessage(sock, chatId, { text: card('🌙 Tonight’s posts', `📅 ${formatDate(tomorrow)} · 12:00 AM\n🕛 ${TIMEZONE_LABEL}`, 'No posts are scheduled for this date.\nUse `/status` to check for missing designs.') });
    return;
  }

  const msg = card('🌙 Tonight’s posts',
    `📅 ${formatDate(tomorrow)} · 12:00 AM\n📍 Main Group · ${TIMEZONE_LABEL}`,
    `*Ready to send: ${todaysPosts.length}*\n${todaysPosts.map(p => `• ${p.name} · #${p.id}`).join('\n')}`,
    'These posts are scheduled to send automatically.\nUse `/dispatch` to send them early, right now.'
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

async function cancelPost(sock, chatId, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await sendRepMessage(sock, chatId, { text: card('⚠️ Invalid post ID', 'Use the number shown in `/list`.', '*Example*\n`/cancel 18`') });
    return;
  }

  const post = db.getPostById(id);
  if (!post || post.status !== 'pending') {
    await sendRepMessage(sock, chatId, { text: card('🔎 Post not found', `Could not find a pending post with ID #${id}.`, 'Use `/list` to see posts waiting to be sent.') });
    return;
  }

  const changes = db.cancelPost(id);
  
  if (changes > 0) {
    if (post.image_path && fs.existsSync(post.image_path)) {
      try {
        fs.unlinkSync(post.image_path);
      } catch (err) {}
    }
    const cancelMsg = card('🗑️ Birthday cancelled', postDetails(post.name, post.birthday, id), 'Removed from the queue. This post will not be sent.');
    await sendRepMessage(sock, chatId, { text: cancelMsg });
    console.log(`[Commands] Canceled post ID: ${id} and deleted image.`);
  } else {
    await sendRepMessage(sock, chatId, { text: card('🔎 Post not found', `Could not find a pending post with ID #${id}.`, 'Use `/list` to see posts waiting to be sent.') });
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
    return await sendRepMessage(sock, chatId, { text: card('⚠️ Invalid month', 'Use `/status` for this month, `/status next` for next month, or `/status 10` for October.') });
  }

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = monthNames[Number(targetMonth) - 1] || `Month ${targetMonth}`;
  const submissions = db.getFormSubmissionsByMonth(`-${targetMonth}-`);
  const manuals = db.getManualAdditionsByMonth(`-${targetMonth}-`);

  if (submissions.length === 0 && manuals.length === 0) {
    return await sendRepMessage(sock, chatId, { text: card(`📊  ${monthName} birthdays`, 'No form entries or birthday posts found for this month.') });
  }

  const designed = submissions.filter(s => s.status === 'designed');
  const pending = submissions.filter(s => s.status === 'pending_design');

  const entries = rows => rows.map(s => {
    const shortDate = formatDate(s.birthday).replace(/ \d{4}$/, '');
    return `${shortDate}  ›  ${s.name.trim().replace(/\s+/g, ' ')}`;
  }).join('\n');
  const msg = card(`📊  ${monthName} birthdays`,
    `✅ *FLYERS COMPLETED · ${designed.length}*\nGoogle Sheet\n\n${entries(designed) || 'None yet.'}`,
    `⚠️ *FLYERS NEEDED · ${pending.length}*\nGoogle Sheet\n\n${entries(pending) || 'All caught up! 🎉'}`,
    `➕ *ADDITIONAL BIRTHDAYS · ${manuals.length}*\nNot in Google Sheet\n\n${entries(manuals) || 'None.'}`,
    '━━━━━━━━━━━━━━\nView posts waiting to be sent: `/list`'
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

module.exports = { handleCommand };
