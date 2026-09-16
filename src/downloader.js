'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Advanced Media Downloader with Puppeteer DOM & Blob Fetch Fallback
 */
async function downloadMedia(msg) {
  if (!msg.hasMedia) {
    throw new Error('Message does not contain media');
  }

  let media = null;

  // 1. පළමු උත්සාහය: සාමාන්‍ය ඩවුන්ලෝඩ් ක්‍රමය
  try {
    media = await msg.downloadMedia();
  } catch (err) {
    console.log('[Downloader] Standard method failed. Trying direct browser DOM extraction...');
  }

  // 2. සාමාන්‍ය ක්‍රමය අසාර්ථක වුණොත්, Puppeteer හරහා WhatsApp Web චැට් DOM එකෙන් සෘජුවම ලබාගැනීම
  if (!media || !media.data) {
    try {
      const client = msg.client;
      const msgId = msg.id._serialized;

      // බ්‍රවුසරේ page එක ඇතුළෙන් image එක fetch කර base64 ලබා ගැනීම
      const base64Data = await client.pupPage.evaluate(async (targetMsgId) => {
        try {
          // අදාළ මැසේජ් එකේ DOM element එක සෙවීම
          const msgEl = document.querySelector(`[data-id="${targetMsgId}"]`);
          if (msgEl) {
            const img = msgEl.querySelector('img');
            if (img && img.src) {
              const response = await fetch(img.src);
              const blob = await response.blob();
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
            }
          }

          // විකල්පයක් ලෙස, ඩොකියුමන්ට් එකේ ඇති මෑතකදි 렌ඩර් වූ මීඩියා ඉමේජ් එකක් ලබා ගැනීම
          const images = Array.from(document.querySelectorAll('img[src^="blob:"], img[src*="whatsapp.net"]'));
          if (images.length > 0) {
            const latestImg = images[images.length - 1];
            const response = await fetch(latestImg.src);
            const blob = await response.blob();
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          }
        } catch (e) {
          return null;
        }
        return null;
      }, msgId);

      if (base64Data) {
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          media = {
            mimetype: matches[1],
            data: matches[2]
          };
        }
      }
    } catch (domErr) {
      console.error('[Downloader] DOM extraction error:', domErr.message);
    }
  }

  if (!media || !media.data) {
    throw new Error('Download failed: r (All media extraction methods blocked by WhatsApp)');
  }

  const uploadDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  let extension = 'jpg';
  if (media.mimetype) {
    if (media.mimetype.includes('png')) extension = 'png';
    else if (media.mimetype.includes('webp')) extension = 'webp';
    else if (media.mimetype.includes('jpeg')) extension = 'jpeg';
  }

  const filename = `birthday_${Date.now()}.${extension}`;
  const filePath = path.join(uploadDir, filename);

  fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
  return filePath;
}

module.exports = { downloadMedia };