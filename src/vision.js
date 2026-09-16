'use strict';

/**
 * vision.js — Groq Vision API Version
 * Extracts name and birthday from a flyer image using Groq Vision.
 */

const fs = require('fs');
const { Groq } = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// .env එකෙන් මොඩල් නම ලබා ගැනීම (නැත්නම් default එකක් පාවිච්චි කරයි)
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

/**
 * Convert local image file to base64 data URL required by Groq Vision
 */
function imageToBase64DataUrl(filePath) {
  const bitmap = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${Buffer.from(bitmap).toString('base64')}`;
}

async function extractBirthdayDetails(imagePath) {
  try {
    const imageUrl = imageToBase64DataUrl(imagePath);

    let completion;
    let retries = 3;
    while (retries > 0) {
      try {
        completion = await groq.chat.completions.create({
          model: VISION_MODEL, // 👈 .env එකෙන් එන Model එක මෙතැනට වැටේ
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Extract the person's name and birthday from this flyer. Return ONLY a valid JSON object with keys "name" and "birthday". The birthday format must be YYYY-MM-DD (if year is missing, assume current year ${new Date().getFullYear()}). Example: {"name": "Kasun Perera", "birthday": "${new Date().getFullYear()}-09-18"}. Do not include any markdown formatting or extra text outside the JSON.`
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl
                  }
                }
              ]
            }
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        });
        break; // සාර්ථක වුණොත් ලූප් එකෙන් එළියට එනවා
      } catch (err) {
        if (err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.includes('Rate limit reached'))) {
          retries--;
          console.warn(`[Vision] ⚠️ Groq Rate limit reached. Waiting 10 seconds before retry... (Retries left: ${retries})`);
          if (retries === 0) throw err;
          await new Promise(res => setTimeout(res, 10000)); // තත්පර 10ක් නවතිනවා
        } else {
          throw err; // වෙනත් error එකක් නම් කෙලින්ම throw කරනවා
        }
      }
    }

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) return null;

    const data = JSON.parse(rawResponse.trim());

    if (!data.name || !data.birthday) {
      console.error('[Vision] Groq JSON missing fields:', data);
      return null;
    }

    return {
      name: data.name.trim(),
      birthday: data.birthday.trim()
    };
  } catch (err) {
    console.error('[Vision] Groq API Error:', err.message);
    return null;
  }
}

module.exports = { extractBirthdayDetails };