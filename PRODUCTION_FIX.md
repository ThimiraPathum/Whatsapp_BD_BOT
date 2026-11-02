# Scheduler incident repair — approval required before deployment

## Baseline and evidence

Original commit: `221bae0f162879d4406c1cc83b4e55660826bc73`, branch `main`.
Baseline: 9 tests passed. Installed dependencies: Baileys 7.0.0-rc14,
node-cron 4.6.0, better-sqlite3 13.0.3. Local runtime: Windows Node 24.6.0;
production target: Ubuntu 24.04, Node 22. No dependency upgrades required.

The supplied production logs show stale-socket `Connection Closed` failures,
many duplicate backups, and missed ticks approximately 2 seconds after 21:00
and midnight. Code registered three new cron jobs at every reconnect, without
destroying previous jobs. Old jobs retained closed sockets and marked failed
sends permanently failed. Installed cron defaults to a 1-second missed-tick
tolerance. Month rollover calculations themselves were correct.

## Implementation

- `src/connection-manager.js`: single-flight socket creation, one reconnect
  timer, 1–60 second exponential backoff, stale-event guard, cleanup, logged-out
  handling. Backoff resets only after a stable connection of at least a minute.
- `src/reliability.js`: one manager, exactly three cron tasks and one 30-second
  reconciliation timer. Dynamic connected-socket lookup; explicit start/stop;
  missed-tick recovery; persistent delivery claims and alerts.
- `src/scheduler.js`: original caption and preview rendering retained; unsafe
  legacy scheduling/dispatch code removed. Transport now passes through manager.
- `src/database.js`: SQLite backup API, unique timestamped destination,
  temporary file + rename, seven-day retention. No raw copying of a WAL database.
  Cancellation cannot delete a post/image while delivery is uncertain/in progress.
- `index.js`: reconnects no longer create jobs; approval sends share the same
  delivery claims as manual/automatic dispatch. Health route is token protected.
- `src/safe-logging.js`: redact known libsignal session-object console messages.
- `tests/reliability.test.js` and updated regression tests: fake clocks/sockets,
  real isolated SQLite and WAL backup. No production WhatsApp sends.
- `README.md`: recovery behavior and link to this deployment guide.

## Recovery and limitations

`delivery_runs` is additive: pending → in_progress → completed, ambiguous or
retryable/permanent/expired. Atomic conditional updates prevent concurrent
claims. Before-send disconnection remains retryable. Any exception after
invoking WhatsApp send, or an absent application message ID, is ambiguous:
**no automatic resend**. Interrupted in-progress sends become ambiguous at
startup. A returned WhatsApp message ID is an application acknowledgement,
not proof that every participant received/read the message.

Automatic dispatch considers only the current local date and posts created
before its midnight. Same-day uploads still require reaction approval. The
default dispatch recovery window is midnight–02:00. Preview recovery is
21:00–midnight and never replays the previous evening. Successful preview and
warning parts are tracked independently. Pause blocks birthday sends, while
preview and backups retain their previous behavior.
Successful preview cycles are also persisted, so reconciliation does not rerun
their queries or emit misleading repeated success logs. Birthday dispatch keeps
the original three-second pacing between posts and rechecks its recovery deadline.

The manually published **Sasini Hansika, 2026-11-01** record is explicitly
excluded from resending. Other historical dates are never replayed. Old failed
records are not automatically reset. Backup recovery can run once later in the
same day if the 00:05 execution was missed.

There is no claim of exactly-once remote delivery: a process can die after
WhatsApp accepts a message but before SQLite commits. Ambiguity requires human
review. Never delete the delivery ledger on restart/rollback. Do not run multiple
PM2 instances or a second bot against the same session/database. This manager
assumes one process, matching the existing PM2 configuration.

Optional `.env` settings (retain every existing setting):

```env
DISPATCH_RECOVERY_MINUTES=120
PREVIEW_RECOVERY_MINUTES=180
HEALTH_TOKEN=<long-random-secret>
ADMIN_ALERT_JID=<private-admin-WhatsApp-JID>
UPDATE_NOTICE_AT=2026-11-02T10:00:00+05:30
```

Preview recovery is capped at midnight. If no private admin JID is configured,
alerts remain in SQLite and structured logs, accessible via authenticated health.
With a private admin JID, at most one summary alert is sent per local day;
Rep/Main group IDs are explicitly rejected as alert destinations.
`/ping` remains HTTP liveness only. Authenticated `/health` separates connection,
job count, last checks, delivery outcomes, backup state and unresolved alerts.
Protect the health token and access this endpoint over localhost/SSH or HTTPS.

`UPDATE_NOTICE_AT` is optional and sends one user-authorized update confirmation
to the configured Rep group. It uses the existing 30-second recovery timer and
durable delivery ledger, adding no cron jobs. Expect it within about 30 seconds
of the configured time when connected. An offline connection may recover for
15 minutes; older notices expire instead of being sent late. A restart cannot
repeat a completed notice, and ambiguous sends are never automatically retried.
This tests the scheduled transport path; the actual evening and midnight jobs
still need observation at their scheduled times. Omit this setting if no update
announcement is wanted. The date shown above is the specifically requested run.

## Deployment (ONLY after explicit authorization)

First publish the reviewed code to a release commit. Do not use unreviewed main
HEAD: substitute the actual reviewed release SHA below. Ensure the working tree
on the server is clean and production runs Node 22. During testing below, the
production service is stopped; tests use isolated DBs and mock WhatsApp only.

```bash
cd ~/Whatsapp_BD_BOT
git status --short
node --version
git rev-parse HEAD
pm2 stop birthday-bot
task_backup="$HOME/birthday-bot-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$task_backup"
cp -a data downloads .baileys_auth .env "$task_backup/"
git rev-parse HEAD > "$task_backup/original-commit.txt"
git fetch origin
git checkout --detach <REVIEWED_RELEASE_SHA>
npm ci
npm test
node --check index.js
```

Stopped-process copying preserves the database AND WAL/SHM together. Keep this
backup private; it contains authentication keys. Do not delete auth, images,
existing backups or WAL. Set the optional health/admin settings securely.

The manager creates `delivery_runs`, `scheduler_alerts` and `scheduler_activity` with CREATE TABLE IF
NOT EXISTS on first startup. No birthday columns or records are deleted. Existing
database initialization still performs the repository's prior form synchronization.

```bash
pm2 restart birthday-bot --update-env
pm2 logs birthday-bot --lines 50 --nostream
```

Startup may send current eligible birthdays inside the recovery window, or a
valid evening preview. Review current pending records before approving startup.
It will not replay historical birthdays, old failed entries or the excluded
November 1 Sasini record.

## Post-deployment verification

1. Check PM2 status, one fork instance, connection log, and protected health:
   `curl -H "Authorization: Bearer $HEALTH_TOKEN" http://127.0.0.1:3000/health`
   (set shell variable securely; do not paste its value into chat/logs).
2. Confirm `initialized: true`, `activeJobs: 3`, `duplicateScheduler: false`,
   WhatsApp ready, recent lastCheck and no unresolved unexpected alerts.
3. Check `/help`, `/list` and `/status` in the authorized Rep workflow.
   Do not use `/dispatch` as a harmless test: it sends tomorrow's real posts.
4. Verify a controlled reconnect leaves activeJobs at 3. Inspect no duplicate
   preview/backup results. Use separate test groups for end-to-end send trials.
5. Verify actual 21:00 preview, midnight dispatch, and 00:05 backup results at
   their next scheduled times. Local simulation is not live scheduled verification.
6. Open latest backup read-only and run `PRAGMA integrity_check;` (expect `ok`).

## Admin review of ambiguous deliveries

Use authenticated health to find delivery keys. Verify the message in the actual
target group and correlate stored message IDs before deciding. Stop PM2 and make
a fresh backup before any reconciliation. With an SQLite client, inspect:

```sql
SELECT * FROM delivery_runs WHERE state IN ('ambiguous','permanent','expired');
SELECT * FROM scheduler_alerts;
```

After confirming `post:123` was actually delivered, a reviewed transaction can
mark its ledger and birthday record completed; retain the image until reviewed:

```sql
BEGIN IMMEDIATE;
UPDATE delivery_runs SET state='completed',detail='Admin verified delivered'
 WHERE key='post:123' AND state='ambiguous';
UPDATE birthday_posts SET status='completed' WHERE id=123
 AND EXISTS(SELECT 1 FROM delivery_runs WHERE key='post:123' AND state='completed');
DELETE FROM scheduler_alerts WHERE key='post:123'
 AND EXISTS(SELECT 1 FROM delivery_runs WHERE key='post:123' AND state='completed');
COMMIT;
```

Only after positively verifying NON-delivery may an operator reset the exact
ledger entry to retryable; only current eligible dates inside recovery windows
are automatic. Never bulk reset failed/ambiguous/history records. For expired
birthdays, publish manually under administrator supervision. Never reset the
Sasini incident exclusion.

## Rollback

Stop PM2 first. Preserve a fresh copy of current data/WAL, images, auth and ledger.
Checkout the recorded previous commit and restore dependencies with `npm ci`.
Do **not** restore an old DB over newer deliveries: doing so loses send history
and can cause duplicates. The previous release ignores the additive tables and
has the original scheduler bug. Keep its automatic scheduler stopped until an
operator reconciles pending records against current delivery_runs, or prefer a
forward fix. Restore the full pre-deploy data snapshot only if no messages or
new submissions occurred after it. Never restore auth or DB piecemeal while running.

Exact code rollback commands (replace the backup-directory placeholder with the
private directory created above; these deliberately leave the old bot stopped):

```bash
cd ~/Whatsapp_BD_BOT
pm2 stop birthday-bot
task_before_deploy='<PRE_DEPLOY_BACKUP_DIRECTORY>'
task_rollback="$HOME/birthday-bot-before-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$task_rollback"
cp -a data downloads .baileys_auth .env "$task_rollback/"
git checkout --detach "$(cat "$task_before_deploy/original-commit.txt")"
npm ci
```

Do not restart that old release until its pending records and uncertain deliveries
have been reconciled. Keeping the service stopped avoids reintroducing the unsafe
automatic sending behavior while an operator chooses a forward fix.

## Verification scope

Baseline passed 9/9. New suite covers 10 reconnects, stale sockets, concurrent
dispatch, preview outage/restart/expiry, zero/one/multiple birthdays, forms,
month/year rollover, approval guard, ambiguous/no-ack sends, incident exclusion,
pause/resume, cleanup, private alert rate limit, and SQLite WAL backup integrity.
Local result before the update-notice addition: 38/38 tests passed after fixing a duplicate-cleanup race found by
the concurrent-dispatch test. A Windows sandbox initially blocked backup-file
rename; the same isolated suite passed outside the sandbox, including real WAL
backup integrity. Syntax checks and `git diff --check` passed.
The new application integration test initially failed on two fixture assumptions
(an unset pause value and uppercase formatted headings); both assertions were
corrected and the complete suite rerun successfully. No unrelated baseline
failures remain.

Executed validation:

```text
npm.cmd test (including update confirmation)       41 passed, 0 failed
node --test tests/regressions.test.js              7 passed, 0 failed
node --check index.js                             passed
node --check src/reliability.js                    passed
node --check src/connection-manager.js             passed
node --check src/database.js                       passed
node --check src/scheduler.js                      passed
node --check src/safe-logging.js                   passed
git diff --check                                  passed (CRLF notices only)
```

Additional evidence: the application integration test runs the actual entry-point
handlers with mocked network/filesystem, exercises /help, /list, /status, /tonight,
/dispatch, pause/resume, manual flyer registration and reaction approval, rejects
commands/reactions outside the Rep group and self reactions, and verifies health
authentication. Timer simulations cover a missed-cron event, a hung 45-second
send with late acknowledgement, a disconnected early manual dispatch followed by
midnight recovery, and health persistence after restart. Real WAL backup validation
checks an uncheckpointed row and SQLite `integrity_check = ok`.

Local Node 24 tests do not replace Node 22/Linux tests or live scheduled checks.
No production access, deployment, restart, database mutation or message sending
was performed during this repair.

**Verdict: READY FOR DEPLOYMENT**, subject to explicit authorization and the
documented Node 22/Linux pre-start tests. This is local code readiness, not a claim
that the live service has been repaired or its next scheduled deliveries verified.
