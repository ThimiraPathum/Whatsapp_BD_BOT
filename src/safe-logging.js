'use strict';

// libsignal currently prints full SessionEntry objects directly to console.
// Redact only these known library messages, keeping ordinary operational logs.
function protectSessionLogs(target = console) {
  for (const method of ['info', 'warn', 'log']) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      if (typeof args[0] === 'string' && /^(Closing session:|Session already closed|Opening session:)/.test(args[0])) {
        original('[WhatsApp] Session state changed (private details omitted)');
      } else original(...args);
    };
  }
}
module.exports = { protectSessionLogs };
