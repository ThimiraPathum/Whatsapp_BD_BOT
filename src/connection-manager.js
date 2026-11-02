'use strict';

function createConnectionManager({ createSocket, onReady, onMessage, onUpdate, loggedOutCode,
  timers = globalThis }) {
  let current = null, ready = false, opening = null, retry = null, attempts = 0, stopped = false, connectedAt = 0;
  function dispose() {
    if (!current) return;
    for (const event of ['connection.update', 'creds.update', 'messages.upsert', 'messages.update']) current.ev.removeAllListeners(event);
    try { current.end?.(new Error('Connection replaced')); } catch {}
    current = null; ready = false;
  }
  function schedule() {
    if (stopped || retry) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6));
    console.log(JSON.stringify({ component: 'whatsapp', event: 'reconnect', delay }));
    retry = timers.setTimeout(() => { retry = null; void start(); }, delay);
  }
  function start() {
    if (stopped) return Promise.resolve();
    if (opening) return opening;
    if (current) return Promise.resolve();
    opening = (async () => {
      try {
        const { socket, saveCreds } = await createSocket();
        if (stopped) { socket.end?.(new Error('Shutdown')); return; }
        current = socket;
        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', update => {
          if (socket !== current || stopped) return;
          onUpdate?.(update);
          if (update.connection === 'open') {
            if (ready) return;
            ready = true; connectedAt = Date.now();
            console.log(JSON.stringify({ component: 'whatsapp', event: 'connected' }));
            Promise.resolve(onReady?.(socket)).catch(() => console.error('[Connection] Ready handler failed'));
          } else if (update.connection === 'close') {
            if (ready && Date.now() - connectedAt >= 60000) attempts = 0;
            const code = update.lastDisconnect?.error?.output?.statusCode;
            dispose();
            if (code === loggedOutCode) { stopped = true; console.error('[Connection] Logged out; relink required'); }
            else schedule();
          }
        });
        socket.ev.on('messages.upsert', event => {
          if (current === socket && ready) Promise.resolve(onMessage(socket, event)).catch(() => console.error('[Connection] Message handler failed'));
        });
      } catch { dispose(); schedule(); }
      finally { opening = null; }
    })();
    return opening;
  }
  function stop() { stopped = true; if (retry) timers.clearTimeout(retry); retry = null; dispose(); }
  return { start, stop, getSocket: () => ready ? current : null };
}
module.exports = { createConnectionManager };
