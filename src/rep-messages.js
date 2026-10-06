'use strict';

// Only the small footer changes. Operational text and message options stay intact.
const lines = {
  scheduled: [
    'Yo, boss! Midnight shift is mine 😎',
    'Got you, bro. You sleep, I work 😂',
    'All booked, my guy. Leave it with me 🫡',
    'Yo, another night shift? Thanks, boss 😂',
    'On the list, bro. Save me some cake 🎂',
    'We’re set, my guy. No alarm for you 😴',
    'Say less, boss. I’ve got the midnight job 😎',
  ],
  duplicate: [
    'Yo, my guy! You sent this already 😂',
    'Easy, bro. One birthday, one post 😂',
    'Boss, I remember. Do you? 👀',
    'Bro, we’ve been here before 😂',
    'Yo, no extra cake for sending it twice 🎂',
    'My guy, it’s already on the list 😂',
    'Got it the first time, bro 😎',
  ],
  reading: [
    'Hold up, bro. Let me read this 🤓',
    'On it, boss. Give me a second 🫡',
    'Yo, checking the small print 👀',
    'One sec, my guy. Bot brain at work 😂',
    'Reading first, bro. Cake later 🎂',
    'Yo, boss. I’m looking, I’m looking 😂',
    'Let me check, my guy. No guessing 🤓',
  ],
  photo: [
    'Yo, nice photo. Now we need the flyer 😂',
    'Bro, someone’s got some designing to do 👀',
    'My guy, where’s the birthday part? 😂',
    'Over to the designers, boss 🫡',
    'Yo, photo’s here. Flyer’s still loading 😂',
    'Needs a birthday design, bro. Your turn 👀',
    'You do the design, my guy. I’ll do the sending 🫡',
  ],
  missing: [
    'Yo, boss! Where’s the flyer? 👀',
    'Bro, “almost done” is not a flyer 😂',
    'My guy, the clock isn’t taking a break 👀',
    'Yo, design team. You still with us? 😂',
    'Boss, I can’t send a work in progress 👀',
    'Bro, time to open that design app 😂',
    'Waiting on you, my guy. No pressure… okay, a little 😂',
  ],
  paused: [
    'Yo, break time! Finally 😎',
    'Thanks, bro. Tea’s on me. Imaginary tea ☕',
    'Boss said rest. Who am I to argue? 😂',
    'Off duty, my guy. Nice 😌',
    'Bro, I’ve been waiting for this 😴',
    'No work? Say less, boss 😂',
    'Taking five, bro. Don’t time me 😎',
  ],
  resumed: [
    'Yo, we’re back! Let’s get to work 🫡',
    'Bro, I just sat down 😂',
    'Missed me already, my guy? 😎',
    'Elama Bota is back, boss 🫡',
    'Yo, holiday’s over. That was quick 😂',
    'Back for more, bro. Still no cake? 🎂',
    'Alright, my guy. Back to work 😎',
  ],
  general: [
    'There you go, my guy 😎',
    'Yo, boss. Keeping you in the loop 🫡',
    'Got you, bro. That’s what Bota does 😎',
    'Your bot’s on duty, my guy 🫡',
    'Yo, another update. I do talk a lot 😂',
    'Keeping you posted, bro. Still unpaid 😂',
    'Elama Bota here, boss. You know the deal 😎',
  ],
};

function withDailyFun(text, now = new Date()) {
  if (typeof text !== 'string') return text;
  // Keep errors, recovery instructions and destructive-operation notices sober.
  if (/CRITICAL ERROR|could not|couldn.t|failed|not ready|INVALID|not provided|FLYER NOT READ|FLYER REQUIRED|wiped|currently PAUSED/i.test(text)) return text;
  let category = 'general';
  if (/BIRTHDAY SCHEDULED/.test(text)) category = 'scheduled';
  else if (/DUPLICATE DETECTED/.test(text)) category = 'duplicate';
  else if (/Analysing flyer|Processing manual entry/.test(text)) category = 'reading';
  else if (/Raw Photo Detected/.test(text)) category = 'photo';
  else if (/UNFINISHED DESIGNS DETECTED|URGENT: NEW SUBMISSION/.test(text)) category = 'missing';
  else if (/BOT PAUSED/.test(text)) category = 'paused';
  else if (/BOT RESUMED/.test(text)) category = 'resumed';

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const part = type => Number(dateParts.find(p => p.type === type).value);
  const day = Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000);
  const choices = lines[category];
  return `${text}\n\n${choices[((day % choices.length) + choices.length) % choices.length]}`;
}

function sendRepMessage(sock, chatId, content, options) {
  const repGroupId = process.env.REP_GROUP_ID?.trim();
  const outgoing = repGroupId && chatId === repGroupId && typeof content.text === 'string'
    ? { ...content, text: withDailyFun(content.text) }
    : content;
  return sock.sendMessage(chatId, outgoing, options);
}

module.exports = { withDailyFun, sendRepMessage };
