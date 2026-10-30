# Hugo as a Muse-style agent (2026-10-29)

The owner compared Hugo with Meta's Muse agent and asked for "the rest of the Muse
phases". This page maps what was built. The model, the routing tiers, live answers
and each person's allowance are in [hugo-speed.md](hugo-speed.md). Tasks and notes
are in [hugo-works-for-you.md](hugo-works-for-you.md).

Every phase keeps Hugo's rules:
- He reads only the person's own records, fresh, with the reach they have now.
- Nothing changes without the person's tap. An approved step runs as them, through
  the product's own route (`dispatchAsUser`).
- Every notice carries the AI disclosure.
- Words are never logged.
- Every model call is charged to the person it was for.
- An associate's Hugo never calls the model (owner, 2026-10-30): none of the model
  phases below reach them. See "Associates' Hugo never calls the model" in
  [hugo-speed.md](hugo-speed.md).

## Goals (phase 3): `lib/hugoGoals.ts`, `hugoGoalActions.ts`, `hugoGoalModel.ts`

**What it is.** The person hands Hugo an outcome, such as "get me 40 hours next
week" or "keep tomorrow fully staffed". A goal is a `HugoTask` of kind `GOAL`, so
the trail, NEEDS_YOU, notices, the badge and the sweep all apply.

**Each step** is one `runModelLoop` (`meter.purpose 'goal'`):
- **Planning** uses `deep`; check-ins use `fast`.
- **Read tools:** the person's registry and pay tools, through `registryForUser`.
- **Its own tools:** `update_plan`, `find_options`, `start_watch` (a child WATCH_*
  task; no approval, since watching changes nothing), `propose`, `tell_person`
  (one a day), `check_back` (1–72 h), `finish` and `set_end_date` (up to 30 days).
- **Memory:** what the person told Hugo ("What Hugo knows") is in the prompt.
- **Continuing:** a first step that only made the plan goes straight on to the
  first useful step.

**Proposals** come from the catalog in `hugoGoalActions.ts`:
- **Associate:** pick up an open shift, request time off, ask coworkers to cover
  a shift, send a schedule-change request, ask the supervisor.
- **Desk:** chase confirmations, give an open shift to a named person, message
  a crew.

A proposal waits for the person as NEEDS_YOU / `GOAL_APPROVAL`. The choices:
- **Approve** runs it as them. A 202 answer reads "Sent for approval"; a refusal
  is shown plainly.
- **Decline** makes him re-plan.
- **Stop** cancels the goal and the children it started.

**Caps** (env):
- `HUGO_GOAL_MAX_OPEN` (3) open goals per person.
- `HUGO_GOAL_MAX_STEPS` (12) steps before he asks "Keep going?".
- `HUGO_GOAL_STEP_GAP_MINUTES` (10) between a goal's own steps.
- `HUGO_GOAL_DAILY_STEPS` (300) per tenant per day.

When the allowance is used up, the goal pauses until it renews.

**Start a goal** from a Start card in chat (the model's `offer_goal`), or with
"Give Hugo a goal" in the Tasks tab. Without the model, goals are not offered.

**Live check (DeepSeek).** In one 30-second step the model made a 4-step plan,
started an open-shift watch, and, finding no morning shifts open, proposed a
schedule-change request to the lead. The planning step cost about $0.013.

## What Hugo knows (phase 4): `lib/hugoMemory.ts`, `packages/shared/src/hugoMemory.ts`

**Storage.** Facts the person told Hugo about themselves, in `HugoMemory`: at most
50, 200 characters each, of kinds PREFERENCE, AVAILABILITY, TRAVEL, WORK or OTHER.
The on/off switch is in `HugoMemorySetting`, and is on by default.
Internal staff have it as well as supervisors (owner, 2026-10-30); each person
sees and changes only their own. An associate's Hugo answers without the model,
the only reader of these facts, so they can't add any (they can still read and
remove what is already kept).

**Saving.** Every save goes through one guard, `checkHugoMemoryText`, in six
languages. It refuses:
- ID, account, card or phone numbers, emails and passwords;
- health, religion, immigration status, orientation, criminal record and union
  membership;
- anything about another person.

**In chat.**
- The model gets `remember_fact` and `forget_fact`, at most 3 saves per answer.
- The facts go in the volatile half of the prompt.
- An answer that saved something shows "Saved to what Hugo knows · Undo".

**The view.** `HugoMemoryView`, from the ⋯ menu, lists the facts and offers edit,
remove, add, the switch, and "Forget everything" behind a confirm.

**Data rights.** The data export includes the facts (`hugo-memory.json`), and
erasure and access cleanup delete them. Audits carry kinds and counts, never text.

**API.** `routes/hugoMemory.ts`, at `/hugo/memory`.

## Waiting for you, Upcoming, Activity (phase 5)

**Waiting for you** (`hugoQueue.ts`) is every task waiting on the person, of every
kind including goal approvals. It is pinned first in the Tasks tab. The home line
"I need a quick answer from you" and `?hugo=waiting` open it.

**Repeats** (`lib/hugoRecurring.ts`) are a task of kind `RECURRING`, such as "every
Friday at 5, tell me my hours" or "each morning, who's short":
- **What they can send:** a registry answer, `MY_HOURS` (`computeAssociateEarnings`,
  never money), or `ASK`, a free question on the fast model
  (`meter.purpose 'recurring'`, no pay tools).
- **Timing:** wall-clock in the person's zone, DST-safe. A run missed by more than
  6 hours is skipped.
- **Lifetime:** after 180 days it asks "Keep going?".
- **Caps:** `HUGO_RECURRING_MAX_PER_USER` (5) and `HUGO_RECURRING_DAILY_MODEL` (200
  per tenant per day).
- **Starting one:** from chat (rules plus the model's `offer_recurring`), or with
  "Repeat something" in the Tasks tab.
- **Upcoming** lists them, with pause, resume, change time and stop.

**Activity** (`GET /hugo/activity`, `lib/hugoActivity.ts`) is the person's own Hugo
history, newest first: task trails, notes accepted or put away, actions confirmed
through Hugo, and the moment the allowance was used up. "See everything Hugo did"
shows it by day.

## The same brain on WhatsApp (phase 6): `lib/hugoWhatsapp.ts`

**What stays deterministic.** Unknown numbers, the call-out flow, YES/NO, STOP,
START, language and "who are you" are handled as before.

**Then the question is routed like the app's:**
1. Work to hand over gets a task offer.
2. A plain question about the person's own records gets the registry's answer at once.
3. Anything else goes to the model (`meter.purpose 'whatsapp'`, the WhatsApp
   instruction: plain text, at most 900 characters, full app links), with the last
   8 messages of the past 24 h and what the person told Hugo. Not for an
   associate: their questions get the registry's answer (route `rules`). The
   model only answers someone on WhatsApp whose account isn't an associate's, such
   as a shift supervisor with their own shifts.

**Escalation.** A model escalation goes to the supervisor at once, and the reply
says it was passed on only when it was.

**Fallbacks.** No key, the tenant cap (`HUGO_WA_MODEL_TENANT_DAILY`, 5000), a used-up
allowance or a failure all fall back to today's registry path. The allowance line
is said once per period.

**Starting tasks.** WATCH_* offers end "Reply START within 30 minutes". START, as
the whole message, starts the task as the person. The offer is kept on the
inbound message's `hugo` column.

## One Hugo per account: `lib/hugoThread.ts`, `routes/hugoAccount.ts`

**Profile.** `HugoProfile`, one per account. The migration backfilled existing
accounts; others get theirs on their first `GET /hugo`. It holds:
- the allowance cycle;
- `readAloud`, which follows the account;
- `threadClearedAt`.

**Conversation.** The chat lives on the server in `HugoTurn` (redacted words, at
most 4,000 characters):
- the model's history is the person's own last 10 turns, read on the server;
  history a client sends is ignored;
- `GET` and `DELETE /hugo/thread`; "Start over" clears it on every device;
- kept 90 days, removed by a sweep (`HUGO_THREAD_RETENTION_DAYS`).

**Allowance on screen** (`HugoAllowance`):
- the ⋯ menu shows "Thinking time this month: N% used · renews …"; staff also see
  dollars;
- a quiet line appears from 80%;
- a calm banner shows when it is used up;
- the home line says it too.

**Admin.** `GET /hugo/admin/usage` (manage:org) gives this period's total, floor
versus staff, by purpose, how many people are used up, and the top 20. It feeds
the "Hugo's thinking time" card on Settings & trust › Agents & gates.

**Data rights.** The export includes `hugo-assistant.json` (profile, turns,
usage), and erasure removes them.

## Migrations
- `20270210090000_hugo_allowance`: `HugoProfile` and `HugoUsage`.
- `20270210100000_hugo_goals`: `HugoTask.parentId` and an index for daily goal steps.
- `20270210110000_hugo_memory`: `HugoMemory` and `HugoMemorySetting`.
- `20270210130000_whatsapp_hugo_state`: `WhatsAppMessage.hugo` (JSONB).
- `20270210140000_hugo_account`: `HugoProfile.readAloud` and `threadClearedAt`,
  `HugoTurn`, and a profile backfill (rows added only).

All of them are additive. The new tables are under the row-level-security wall.
