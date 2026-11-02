'use strict';

const { sendRepMessage } = require('./rep-messages');
const { card, formatDate, postDetails, SEPARATOR } = require('./message-layout');

const db = require('./database');
const fs = require('fs');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';
const TIMEZONE_LABEL = TIMEZONE === 'Asia/Colombo' ? 'ශ්‍රී ලංකා වේලාවෙන්' : TIMEZONE;

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
        await sendRepMessage(sock, chatId, { text: card('⚠️ පෝස්ට් අංකය සඳහන් කර නැත', '`/list` මඟින් පෝස්ටුව තෝරා එහි අංකය යොදන්න.', '*උදාහරණය*\n`/cancel 18`') });
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
        const msgKey = await sendRepMessage(sock, chatId, { text: card('⏳ උපන්දින පෝස්ටු යවමින් පවතී', 'අද රාත්‍රී 12:00 ට නියමිත පෝස්ටු දැන් Main Group එකට යවමින් පවතී…') });
        if (dispatchNowFunction) {
          const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
          const count = await dispatchNowFunction(tomorrow);
          await sendRepMessage(sock, chatId, { text: card('✅ යැවීමේ පරීක්ෂාව අවසන්', `📅 ${formatDate(tomorrow)}\n📤 *Main Group එකට යැවූ පෝස්ටු · ${count || 0}*`, 'සාර්ථකව යැවූ පෝස්ටු රාත්‍රී 12:00 ට නැවත යැවෙන්නේ නැත.\nයැවීමට ඉතිරි පෝස්ටු බැලීමට: `/list`'), edit: msgKey.key });
        } else {
          await sendRepMessage(sock, chatId, { text: card('⏳ යැවීම තවම සූදානම් නැත', 'මඳ වේලාවකින් නැවත `/dispatch` භාවිත කරන්න.\nකිසිදු පෝස්ටුවක් යවා නැත.'), edit: msgKey.key });
        }
      }
      break;

    case '/pause':
      db.setBotPaused(true);
      await sendRepMessage(sock, chatId, { text: card('⏸️ Bot තාවකාලිකව නවතා ඇත', '📸 අලුත් ෆ්ලයර් ඇතුළත් කිරීම නවතා ඇත.\n🕛 ස්වයංක්‍රීය පෝස්ට් යැවීම නවතා ඇත.', 'නැවත ආරම්භ කිරීමට: `/resume`') });
      break;

    case '/clear-form':
      db.clearFormSubmissions();
      await sendRepMessage(sock, chatId, { text: card('🧹 Form සටහන් ඉවත් කළා', 'නිම කළ ෆ්ලයර්වලට අදාළ සටහන් ඇතුළුව සියලු Form සටහන් ඉවත් කළා.\nඋපන්දින පෝස්ටු ඉවත් කර නැත.', 'දැන් Google Sheet එකෙන් Form දත්ත නැවත sync කළ හැක.') });
      break;

    case '/resume':
      db.setBotPaused(false);
      await sendRepMessage(sock, chatId, { text: card('▶️ Bot නැවත ක්‍රියාත්මකයි', '📸 දැන් අලුත් ෆ්ලයර් upload කළ හැක.\n🕛 ස්වයංක්‍රීය පෝස්ට් යැවීම නැවත ක්‍රියාත්මකයි.') });
      break;

    default:
      if (cmd !== '/add' && cmd !== '/id') {
          await sendRepMessage(sock, chatId, { text: card('❓ විධානය හඳුනාගත නොහැක', 'භාවිත කළ හැකි විධාන බැලීමට: `/help`') });
      }
      break;
  }
}

async function showHelpMenu(sock, chatId) {
  const menu = card('🤖 Elama Bota — විධාන මාර්ගෝපදේශය',
    '*📊 ෆ්ලයර්වල ප්‍රගතිය*\n`/status` — මේ මාසය\n`/status next` — ලබන මාසය\n`/status 10` — ඔක්තෝබර් මාසය',
    '*📸 උපන්දින පෝස්ටුවක් ඇතුළත් කිරීම*\nනිම කළ ෆ්ලයර් එක upload කරන්න.\nඑය කියවාගත නොහැකි නම් පහත caption එක සමඟ නැවත upload කරන්න:\n`/add Kasun Perera | 2026-10-20`\n\nඋදාහරණය වෙනුවට නිවැරදි නම සහ දිනය යොදන්න. ෆ්ලයර් ඡායාරූපය අනිවාර්යයි.',
    '*📋 පෝස්ටු බැලීම*\n`/list` හෝ `/pending` — යැවීමට ඉතිරි සියලු පෝස්ටු\n`/tonight` හෝ `/today` — අද රාත්‍රී 12:00 ට නියමිත පෝස්ටු',
    '*🛠️ පෝස්ටු කළමනාකරණය*\n`/cancel 18` — #18 පෝස්ටුව ඉවත් කරන්න\n`/dispatch` — අද රාත්‍රී 12:00 ට නියමිත පෝස්ටු දැන්ම යවන්න',
    '*⏯️ Bot පාලනය*\n`/pause` — ෆ්ලයර් ඇතුළත් කිරීම සහ පෝස්ට් යැවීම නවතන්න\n`/resume` — නැවත ආරම්භ කරන්න',
    `🕛 සියලු වේලාවන්: ${TIMEZONE_LABEL}`
  );
  await sendRepMessage(sock, chatId, { text: menu });
}

async function listPendingPosts(sock, chatId) {
  const pending = db.listPending();
  
  if (pending.length === 0) {
    await sendRepMessage(sock, chatId, { text: card('📋 යැවීමට නියමිත පෝස්ටු', 'යැවීමට ඉතිරි පෝස්ටු නැත.', 'අලුත් පෝස්ටුවක් ඇතුළත් කිරීමට උපන්දින ෆ්ලයර් එක upload කරන්න.') });
    return;
  }

  const msg = card('📋 යැවීමට නියමිත පෝස්ටු',
    `*යැවීමට ඉතිරි · ${pending.length}*`,
    ...pending.map(p => postDetails(p.name, p.birthday, p.id)),
    `🕛 උපන්දිනයේ 12:00 AM · ${TIMEZONE_LABEL}\nපෝස්ටුවක් ඉවත් කිරීමට: \`/cancel [ID]\``
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

async function showTonightBirthdays(sock, chatId) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const todaysPosts = db.getPendingForToday(tomorrow);

  if (todaysPosts.length === 0) {
    await sendRepMessage(sock, chatId, { text: card('🌙 අද රාත්‍රියේ පෝස්ටු', `📅 ${formatDate(tomorrow)} · 12:00 AM\n📍 Main Group · ${TIMEZONE_LABEL}`, 'මෙම දිනයට පෝස්ටු ඇතුළත් කර නැත.\nසැකසිය යුතු ෆ්ලයර් බැලීමට: `/status`') });
    return;
  }

  const msg = card('🌙 අද රාත්‍රියේ පෝස්ටු',
    `📅 ${formatDate(tomorrow)} · 12:00 AM\n📍 Main Group · ${TIMEZONE_LABEL}`,
    `*යැවීමට සූදානම් · ${todaysPosts.length}*\n${todaysPosts.map(p => `• ${p.name} · #${p.id}`).join('\n')}`,
    'මෙම පෝස්ටු අද රාත්‍රී 12:00 ට ස්වයංක්‍රීයව යැවේ.\nඊට පෙර දැන්ම යැවීමට: `/dispatch`'
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

async function cancelPost(sock, chatId, idStr) {
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await sendRepMessage(sock, chatId, { text: card('⚠️ පෝස්ට් අංකය වැරදියි', '`/list` මඟින් පෙන්වන අංකය යොදන්න.', '*උදාහරණය*\n`/cancel 18`') });
    return;
  }

  const post = db.getPostById(id);
  if (!post || post.status !== 'pending') {
    await sendRepMessage(sock, chatId, { text: card('🔎 පෝස්ටුව හමු නොවීය', `යැවීමට ඉතිරි පෝස්ටු අතර #${id} පෝස්ටුව හමු නොවීය.`, 'යැවීමට ඉතිරි පෝස්ටු බැලීමට: `/list`') });
    return;
  }

  const changes = db.cancelPost(id);
  
  if (changes > 0) {
    if (post.image_path && fs.existsSync(post.image_path)) {
      try {
        fs.unlinkSync(post.image_path);
      } catch (err) {}
    }
    const cancelMsg = card('🗑️ උපන්දින පෝස්ටුව අවලංගු කළා', postDetails(post.name, post.birthday, id), 'යැවීමේ ලැයිස්තුවෙන් ඉවත් කළා. මෙම පෝස්ටුව යැවෙන්නේ නැත.');
    await sendRepMessage(sock, chatId, { text: cancelMsg });
    console.log(`[Commands] Canceled post ID: ${id} and deleted image.`);
  } else {
    await sendRepMessage(sock, chatId, { text: card('⚠️ පෝස්ටුව ඉවත් කළ නොහැක', `#${id} පෝස්ටුව යවමින් තිබිය හැක, දැනටමත් යවා තිබිය හැක හෝ යැවීමේ තත්ත්වය තහවුරු වී නැති විය හැක.`, 'නැවත උත්සාහ කිරීමට පෙර පරිපාලකයාගෙන් තත්ත්වය තහවුරු කරගන්න.\nපෝස්ටු බැලීමට: `/list`') });
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
    return await sendRepMessage(sock, chatId, { text: card('⚠️ මාසය නිවැරදිව සඳහන් කරන්න', 'මේ මාසයට `/status`, ලබන මාසයට `/status next`, හෝ ඔක්තෝබර් මාසයට `/status 10` භාවිත කරන්න.') });
  }

  const monthNames = ['ජනවාරි', 'පෙබරවාරි', 'මාර්තු', 'අප්‍රේල්', 'මැයි', 'ජූනි', 'ජූලි', 'අගෝස්තු', 'සැප්තැම්බර්', 'ඔක්තෝබර්', 'නොවැම්බර්', 'දෙසැම්බර්'];
  const monthName = monthNames[Number(targetMonth) - 1] || `${targetMonth}`;
  const submissions = db.getFormSubmissionsByMonth(`-${targetMonth}-`);
  const manuals = db.getManualAdditionsByMonth(`-${targetMonth}-`);

  if (submissions.length === 0 && manuals.length === 0) {
    return await sendRepMessage(sock, chatId, { text: card(`📊 ${monthName} මාසයේ උපන්දින`, 'මෙම මාසයට Form සටහන් හෝ උපන්දින පෝස්ටු හමු නොවීය.') });
  }

  const designed = submissions.filter(s => s.status === 'designed');
  const pending = submissions.filter(s => s.status === 'pending_design');

  const entries = rows => rows.map(s => {
    const shortDate = formatDate(s.birthday).replace(/ \d{4}$/, '');
    return `${shortDate}  ›  ${s.name.trim().replace(/\s+/g, ' ')}`;
  }).join('\n');
  const msg = card(`📊 ${monthName} මාසයේ උපන්දින`,
    `✅ *නිම කළ ෆ්ලයර් · ${designed.length}* (Google Sheet)\n${entries(designed) || 'තවමත් නැත.'}`,
    `⚠️ *සැකසිය යුතු ෆ්ලයර් · ${pending.length}* (Google Sheet)\n${entries(pending) || 'සියල්ල සූදානම්! 🎉'}`,
    `➕ *වෙනත් උපන්දින · ${manuals.length}* (Google Sheet හි නැති)\n${entries(manuals) || 'වෙනත් උපන්දින නැත.'}`,
    `${SEPARATOR}\nයැවීමට නියමිත පෝස්ටු බැලීමට: \`/list\``
  );
  await sendRepMessage(sock, chatId, { text: msg });
}

module.exports = { handleCommand };
