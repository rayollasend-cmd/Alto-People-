# Hugo works for you — tasks and notes

Owner's ask (2026-10-25): give Hugo a task and carry on; he says when it is done;
he makes recommendations on his own. Built as two things, one set of rules.

## The rules every part keeps

- **Only the person's own records**, read fresh on every step with the reach they have
  now (`sessionUserById`). A role revoked mid-task stops it.
- **Nothing changes a record without the person's tap.** A task is started by a tap;
  a note is accepted by a tap. Asking coworkers to cover a shift is the one thing a
  task does on someone's behalf, and starting that task is the tap: the manager still
  approves, and the person stays on the shift until then.
- **No spam.** At most two notes a day reach the lock screen, none before 8 AM or after
  8 PM on the person's clock (and their own quiet hours on top). Every kind of note can
  be turned off (Settings › Notifications › "What Hugo notices for you"). Watches don't
  repeat a notice another flow already sent (a time-off decision already tells them).
- **Every step on the trail.** Each task keeps a trail (`HugoTaskEvent`); every change
  of state is on Hugo's agent trail (`agent.task.*`, `agent.note.*`); every notice carries
  the AI disclosure and Hugo's id (`byAgentId`).
- **Six languages.** The web renders every title, step and choice from codes
  (`packages/shared/src/hugoWork.ts`, `hugoWork.*` keys); the server writes only the
  notices, in en/es/tr/ht/pt/uk (`lib/hugoWorkCopy.ts`).

## Tasks (`lib/hugoTasks.ts`)

| Kind | Who | What it does | Done / needs you |
| --- | --- | --- | --- |
| `WATCH_TIME_OFF` | associate | watches their pending requests | decided (no extra notice) |
| `WATCH_OPEN_SHIFTS` | associate | an open shift that fits (eligible, availability, not declined) within N days | found → notice with the marketplace link |
| `WATCH_PAYCHECK` | associate | their next disbursed pay item | paid → notice with the paystub link (never the amount) |
| `WATCH_DOCUMENT` | associate | their uploads under review | verified → notice; rejected → needs a new upload |
| `FIND_COVER` | associate | asks free coworkers one at a time (fewest hours that week first), withdraws an unanswered ask after a quarter of the time left (1–6 h) | approved → notice; no one / rejected → keep trying, pass to supervisor, or stop; shift about to start → "you're still on it" |
| `CHASE_CONFIRMATIONS` | scheduling desk | nudges tomorrow's unconfirmed shifts in the desk's reach, counts | all in → notice; a call-off or the evening cutoff → needs the desk |

Statuses: `WORKING`, `WAITING` (on someone else), `NEEDS_YOU`, and final `DONE`,
`CANCELLED`, `FAILED`, `EXPIRED`. A task steps on the `hugoTasks` timer
(`HUGO_TASKS_INTERVAL_SECONDS`, default 120), when its person opens the list, and on
the events it waits for (a swap answered, a time-off decision). One step at a time per
task: a guarded claim (`claimedAt`) taken over when stale. Five failed steps in a row
and it fails. Swaps Hugo asks for go through `lib/shiftSwaps.ts` — the same code as the
swap screen — with the manager's copy held until a coworker says yes, and the
requester's per-step swap notices replaced by Hugo's.

## Notes (`lib/hugoNotes.ts`)

| Kind | Who | Raised when | Reaches |
| --- | --- | --- | --- |
| `CREDENTIAL_EXPIRING` | associate | the compliance agent's chase list has one of theirs | panel and home only |
| `OPEN_SHIFT_MATCH` | associate | an open shift fits them and the invite didn't already tell them | push (at most every three days) |
| `DIRECT_DEPOSIT_MISSING` | associate | no account on file and the first payday is within a week | push, once |
| `UNCONFIRMED_TOMORROW` | scheduling desk | after noon, tomorrow has unconfirmed shifts and Hugo isn't already chasing | panel and home only; accepting starts the chase |

One per person, kind and subject: a dismissed note stays dismissed; a note no longer
true expires. The `hugoNotes` timer (`HUGO_NOTES_INTERVAL_SECONDS`, default 3600) runs
the detectors per tenant and sends the pushes due.

## API (`routes/hugo.ts`, the caller's own rows only)

`GET/POST /hugo/tasks`, `GET /hugo/tasks/:id`, `POST /hugo/tasks/:id/cancel`,
`POST /hugo/tasks/:id/respond`, `GET /hugo/notes`, `POST /hugo/notes/:id/accept|dismiss`,
`GET/PUT /hugo/notes/settings`, `POST /hugo/seen`, `GET /hugo/summary` (the badge; zeros
when Hugo is off). In the chat, "find cover…", "tell me when…", "chase tomorrow's
confirmations" and "what are you working on?" answer with Start cards
(`lib/hugoTaskChat.ts`), the same with or without the model.

## Web

The panel's Tasks tab (`HugoTasksPanel`), Start cards in the chat (`HugoTaskOffer`),
the badge and working ring on the top-bar button and the phone launcher (`HugoBadge`),
"Hugo noticed" on the home seat, the Settings card (`HugoNotesCard`), a "Tasks waiting
on you" inbox row, and links any notice can carry: `?hugo=tasks`, `?hugo=task:<id>`,
`?hugo=notes`, `?hugo=chat` (a URL contract — keep them working).
