'use strict';

const SEPARATOR = '━━━━━━━━━━━━━━';

// Native WhatsApp formatting with a compact heading and open section layout.
function card(title, ...sections) {
  const heading = title.trim().replace(/^(\S+)\s+/, '$1  ').toUpperCase();
  return [`*${heading}*\n${SEPARATOR}`, ...sections.filter(Boolean)].join('\n\n');
}

function formatDate(value, month = 'short') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month, year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

function postDetails(name, birthday, id) {
  return [
    `👤 *${String(name).trim()}*`,
    birthday && `📅 ${formatDate(birthday)}`,
    id != null && `🆔 #${id}`,
  ].filter(Boolean).join('\n');
}

module.exports = { card, formatDate, postDetails, SEPARATOR };
