const title = 'Phase 52 follow-up: sweep other shift mutations for approved-PTO awareness';

const body = [
  'Phase 52 (commit f7df321) added approved-`TimeOffRequest` checks to:',
  '- `GET /scheduling/shifts/:id/conflicts` (UI hard-warning in AssignDialog)',
  '- `GET /scheduling/shifts/:id/auto-fill` (forces score to 0 + flag)',
  '',
  "Other shift-mutating paths were **not** updated and may silently schedule onto an associate's approved PTO. Sweep these in `apps/api/src/routes/scheduling.ts` and report a punch list (no implementation):",
  '',
  "- [ ] **`POST /scheduling/copy-week`** — bulk-copies an entire week's shifts forward. If an assigned associate now has approved PTO in the target week, are we duplicating onto it?",
  '- [ ] **`POST /scheduling/templates/:id/apply`** — single-template apply. Same question for the chosen day.',
  '- [ ] **`POST /scheduling/shifts/:id/assign`** — direct assignment bypasses AssignDialog (curl, scripted assigns, etc.). Should this hard-block (or at least warn-log to AuditLog) when the associate is on PTO?',
  "- [ ] **Swap acceptance** (`peer-accept`, `manager-approve`) — does accepting a swap onto an associate who's now on PTO get caught anywhere?",
  '',
  'For each, note:',
  '1. Whether it currently honors PTO (yes / no / partial).',
  "2. The user-visible failure mode if it doesn't.",
  '3. A one-paragraph proposed fix referencing line numbers.',
  '',
  'Reference: the day-bound query pattern is in `scheduling.ts` around the conflicts handler — `startDate: { lte: targetDayEnd }, endDate: { gte: targetDayStart }` against APPROVED rows.',
].join('\n');

const url =
  'https://github.com/rayollasend-cmd/Alto-People-/issues/new?title=' +
  encodeURIComponent(title) +
  '&body=' +
  encodeURIComponent(body);

console.log(url);
