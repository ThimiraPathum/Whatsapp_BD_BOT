'use strict';

// Preserve Sinhala text and formatting, including message edits and reply metadata.
function sendRepMessage(sock, chatId, content, options) {
  return sock.sendMessage(chatId, content, options);
}

module.exports = { sendRepMessage };
