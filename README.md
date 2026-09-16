# 🎂 WhatsApp Birthday Bot
### University of Colombo — Faculty of Technology, 22/23 Batch

A fully automated WhatsApp bot that schedules and dispatches birthday greeting posts at exactly **12:00 AM** with zero human intervention at midnight.

---

## Architecture Overview

```
Rep Group (admins drop images)
        │
        ▼
   whatsapp-web.js
        │  detects image
        ▼
   Downloader → saves to downloads/
        │
        ▼
   Claude Vision API (OCR)
        │  extracts name + date
        ▼
   SQLite Database  ←──── quote-reply confirmation
        │
        ▼ (midnight cron — Asia/Colombo)
   Scheduler
        │  reads pending rows for today
        ▼
   Main Group  ← sends image + caption
        │
        ▼
   DB updated → status: "completed"
```

---

## Project Structure

```
whatsapp-birthday-bot/
├── index.js                  # Bot entry point — client init + message handler
├── ecosystem.config.js       # PM2 production config
├── .env.example              # Environment variable template
│
├── src/
│   ├── database.js           # SQLite schema + all CRUD functions
│   ├── vision.js             # Claude claude-sonnet-4-6 vision OCR module
│   ├── downloader.js         # WhatsApp media download helper
│   ├── scheduler.js          # node-cron midnight dispatch job
│   └── commands.js           # Admin text command handler (/list, /cancel, etc.)
│
├── tools/
│   └── list-groups.js        # One-time utility: discover WhatsApp group IDs
│
├── data/
│   └── birthdays.db          # SQLite database (auto-created on first run)
│
└── downloads/                # Downloaded birthday card images (auto-created)
```

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 8 |
| Chromium / Google Chrome | installed on the host |
| Anthropic API key | any tier with Claude claude-sonnet-4-6 access |

> **Server note:** The bot uses Puppeteer to control a headless Chrome instance for WhatsApp Web. Your server needs Chrome installed:
> ```bash
> # Ubuntu/Debian
> sudo apt-get install -y chromium-browser
> # or
> sudo apt-get install -y google-chrome-stable
> ```

---

## Setup & Installation

### 1. Clone and install dependencies

```bash
git clone <your-repo-url>
cd whatsapp-birthday-bot
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

> `PUPPETEER_SKIP_DOWNLOAD=true` skips Puppeteer downloading its own Chrome, since we use the system Chrome.

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in your `ANTHROPIC_API_KEY`. Leave the group IDs blank for now.

### 3. Discover your WhatsApp Group IDs

```bash
node tools/list-groups.js
```

Scan the QR code with your WhatsApp account (the bot's number). After login, all your groups and their IDs are printed:

```
Found 5 group(s):

[1] FoT 22/23 — Reps
    ID: 120363123456789012@g.us

[2] FoT 22/23 — Main Batch
    ID: 120363987654321098@g.us
...
```

Copy the two relevant IDs into `.env`:

```env
REP_GROUP_ID=120363123456789012@g.us
MAIN_GROUP_ID=120363987654321098@g.us
```

### 4. (Optional) Customise the caption

In `.env`, you can override the midnight post caption:

```env
BIRTHDAY_CAPTION=🎂 Happy Birthday, {name}! 🎉\n\nWith love from the FoT 22/23 Batch! #UColombo
```

`{name}` is replaced with the student's name at dispatch time.

---

## Running the Bot

### Development

```bash
node index.js
```

Scan the QR code once. The session is saved to `.wwebjs_auth/` so subsequent starts don't need a re-scan.

### Production (with PM2)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save           # persist across reboots
pm2 startup        # generate systemd/init script
```

Monitor in real-time:
```bash
pm2 monit
pm2 logs birthday-bot
```

---

## Daily Usage

### Scheduling a Birthday Post

1. An admin drops a birthday greeting image (PNG or JPG) into the **Rep Group**.
2. The bot downloads it, sends it to Claude for OCR, and immediately quote-replies:

```
✅ Scheduled!

📅 Date : 2026-09-22
👤 Name : Lahiru Rasanga
🆔 ID   : 7

Ready for dispatch at 12:00 AM. Use /list to view all or /cancel 7 to remove.
```

3. At exactly **12:00 AM (Asia/Colombo)**, the bot sends the image + caption to the **Main Group** automatically.

### Admin Commands (send in Rep Group)

| Command | Description |
|---|---|
| `/list` | Show all pending scheduled posts |
| `/cancel <id>` | Remove a pending post by its ID |
| `/dispatch` | Manually trigger today's dispatch (for testing) |
| `/help` | Show command list |

---

## Database Schema

```sql
CREATE TABLE birthday_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,           -- Extracted student name
  birthday    TEXT    NOT NULL,           -- ISO date: YYYY-MM-DD
  image_path  TEXT    NOT NULL,           -- Absolute path on disk
  status      TEXT    DEFAULT 'pending',  -- pending | completed | failed
  msg_id      TEXT,                       -- WhatsApp message ID (for audit)
  chat_id     TEXT,                       -- Rep group chat ID
  created_at  TEXT    DEFAULT (datetime('now')),
  posted_at   TEXT                        -- Set when dispatched
);
```

You can query it directly for auditing:
```bash
sqlite3 data/birthdays.db "SELECT id, name, birthday, status FROM birthday_posts ORDER BY birthday;"
```

---

## How the AI Vision Works

When an image arrives:

1. The image is read from disk and base64-encoded.
2. It's sent to **Claude claude-sonnet-4-6** with a focused system prompt:
   - Extracts exactly two fields: `name` and `birthday` (YYYY-MM-DD)
   - Returns pure JSON — no markdown, no prose
3. The response is parsed and validated.
4. If either field is null or the date format is wrong, the bot sends a warning in the Rep Group.

The Claude vision model handles varied card designs, fonts, and layouts reliably.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| QR code keeps reappearing | Delete `.wwebjs_auth/` and re-scan |
| "Could not extract details from this image" | Ensure name and date are clearly readable; try higher-quality image |
| Bot not responding in Rep Group | Double-check `REP_GROUP_ID` in `.env` |
| Posts not dispatching at midnight | Verify `TIMEZONE=Asia/Colombo` and that PM2 is running |
| Chrome not found error | Install Chromium: `sudo apt-get install chromium-browser` |

---

## Security Notes

- Never commit `.env` to git (it's in `.gitignore`)
- Never commit `.wwebjs_auth/` — it contains your WhatsApp session tokens
- The bot only responds to messages in the configured Rep Group; it ignores all other chats

---

## Tech Stack

| Component | Library |
|---|---|
| WhatsApp automation | [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) |
| AI Vision / OCR | [Anthropic Claude claude-sonnet-4-6](https://www.anthropic.com) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Scheduler | [node-cron](https://github.com/node-cron/node-cron) |
| Process manager | [PM2](https://pm2.keymetrics.io) |

---

*Built for the UColombo FoT 22/23 Batch 🎓*
