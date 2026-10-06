# WhatsApp Birthday Bot

Birthday flyer scheduling for University of Colombo, Faculty of Technology, 22/23 batch.

## Workflow

1. Upload a completed birthday flyer to the Rep Group.
2. Baileys saves the image in `downloads/`. Groq Vision extracts its name and date. Images classified as raw photographs are ignored.
3. SQLite stores the pending post. The bot replies with its date and ID; duplicate pending name/date pairs are rejected.
4. At 9 PM, the Rep Group receives tomorrow's preview and a warning for unfinished form designs.
5. At midnight, the bot sends that date's pending posts to the Main Group, marks successful posts completed and deletes their images.

Schedules use `TIMEZONE`, defaulting to `Asia/Colombo`. The bot must be running and connected at dispatch time. Failed posts are marked failed; there is no automatic failed-post retry job.

For a flyer dated today, react to the bot's prompt with 👍 to send immediately or ❌ to cancel. Reaction prompts are held in memory and do not survive a restart.

## Setup

Install Node.js compatible with the dependencies in `package-lock.json`, then run `npm ci`. The current Baileys bot does not require Chrome or Puppeteer.

Create `.env` in the project root:

```env
GROQ_API_KEY=your-groq-api-key
REP_GROUP_ID=your-rep-group-id@g.us
MAIN_GROUP_ID=your-main-group-id@g.us
TIMEZONE=Asia/Colombo
PORT=3000
# Optional: override the default in src/vision.js with a vision-capable model.
# GROQ_VISION_MODEL=your-vision-model
# BIRTHDAY_CAPTION="Happy Birthday, {name}!"
```

`{name}` in the caption uses the first suitable name component; `{date}` uses the scheduled date.

Run `npm start` and scan the terminal QR code using the bot's WhatsApp account. Credentials persist in `.baileys_auth/`.

To discover group IDs, initially configure nonempty placeholder group IDs and start the bot. From another WhatsApp account, send `/id` in each target group. Copy the returned IDs into `.env` and restart. The legacy `tools/list-groups.js` still uses WhatsApp Web.js, which is no longer a dependency; use `/id` instead.

## Commands

Rep Group messages keep their existing layout and instructions, with a short
English footer with “Yo”, “bro”, “my guy” and “boss” from Elama Bota. Footers rotate at midnight in
`Asia/Colombo`, repeat after seven days, and use no AI calls. Errors and recovery
instructions stay plain. Main Group birthday messages are unchanged. Edit the
footer collections in `src/rep-messages.js` to adjust the jokes.

Commands are restricted to the Rep Group, except `/id`. There is no individual member admin-role check.

| Command | Action |
|---|---|
| `/help`, `/menu` | Show command guide |
| `/add Name \| YYYY-MM-DD` | Supply details manually in an uploaded flyer's caption |
| `/list`, `/pending` | List pending posts |
| `/today`, `/tonight` | Show tomorrow's posts for the upcoming midnight |
| `/dispatch` | Send those same tomorrow-dated posts immediately; respects pause state |
| `/cancel ID`, `/delete ID` | Remove a pending post and its local image |
| `/status`, `/designs` | This month's form/design report |
| `/status next`, `/status 10` | Report for next month or a specified month |
| `/pause`, `/resume` | Pause/resume flyer intake and scheduler dispatch |
| `/clear-form` | Delete all form submissions, including designed entries |
| `/id` | Reply with the current chat ID, including outside the Rep Group |

If AI extraction fails, re-upload the flyer with a caption such as `/add Kasun Perera | 2026-10-18`. An attached image is required.

## Form API and monitoring

Express listens on `PORT` (default `3000`):

- `GET /ping` returns `pong`. This checks HTTP liveness, not WhatsApp connectivity.
- `POST /api/submit-form` accepts JSON with `name`, `birthday`, and `photoUrl`. It stores a submission awaiting a flyer and alerts the Rep Group for submissions in the current month.

The endpoint currently has no authentication. Google Forms/Sheets forwarding must be configured separately; no forwarding script or form frontend is included. Form design status is reconciled automatically at database initialization and whenever a flyer or form submission is saved (including duplicate form submissions). Matching uses the birthday date and name prefix, whether the form or flyer arrives first. No manual repair command is needed.

## Project files

| File | Purpose |
|---|---|
| `index.js` | Baileys connection, messages/reactions and Express API |
| `src/vision.js` | Groq image analysis |
| `src/database.js` | SQLite schema, post/form operations, pause state and backups |
| `src/scheduler.js` | Midnight dispatch, 9 PM preview and 12:05 AM backups |
| `src/commands.js` | Commands and design reports |
| `ecosystem.config.js` | PM2 configuration |
| `src/downloader.js` | Legacy WhatsApp Web.js helper, unused by the current entry point |

SQLite data lives in `data/birthdays.db`, with tables `birthday_posts` (pending/completed/failed), `form_submissions` (pending_design/designed), and `config`. The daily backup job copies the database into `data/backups/` and removes backups older than seven days.

Keep `.env` and `.baileys_auth/` private. Preserve `data/`, pending images in `downloads/`, and the session directory across deployments.

## Production

With PM2 installed:

```sh
pm2 start ecosystem.config.js
pm2 save
pm2 logs birthday-bot
```

Configure startup using your host's supported mechanism. PM2 runs one instance with automatic restarts and a 512 MB memory restart threshold. Restart the process after code or environment changes.

## Tests

Run `npm test`. Regression tests use simulated WhatsApp/AI clients and an in-memory database, without accessing WhatsApp, Groq or production data.
