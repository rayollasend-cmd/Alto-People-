# Hugo: fast answers, live answers, each person's allowance

Built 2026-10-29. The owner asked for Hugo to work more like Meta's Muse: answers
that come quickly, cost little, and show what he is doing while he works.

**The model is DeepSeek** (the owner's choice, 2026-10-29). It is reached through
DeepSeek's Anthropic-compatible API, `https://api.deepseek.com/anthropic`, so the
same SDK, tool loop and streaming serve it (`lib/assistantModel.ts`).
- The key is the Railway variable the owner named `Hugo`; `DEEPSEEK_API_KEY` also works.
- DeepSeek refuses the SDK's `type: "custom"` on a tool definition, so `compatFetch`
  drops it before the request goes out.
- A probe with the real key showed tool calls, thinking, streaming and cache
  accounting all working, with answers in 2–3 s and the first words at about 1.9 s.

## Three ways to answer, quickest first

`apps/api/src/lib/hugoRouting.ts` picks one per question.

| Tier | What answers | When |
| --- | --- | --- |
| `instant` | The registry (`lib/hugo`), no model | A suggestion tapped (the registry's own example question), or a worker's or driver's short question (7 words or fewer) about their own payday, shifts, ride or documents, with no word of judgment in it ("why", "wrong", "didn't", "how much", "swap", "late"…) |
| `fast` | `ASSISTANT_FAST_MODEL` (default `deepseek-flash`), no extended thinking, 800 tokens | Everything else: everyday questions |
| `deep` | `ASSISTANT_MODEL` (default `deepseek-v4-pro`), adaptive thinking at medium effort, 1,200 tokens | An action to set up (the person has `propose_*` tools and the words ask for one), numbers to run (the person has the report tool and the words ask how many, totals, by month…), several questions at once, or a long story |

The instant path is narrow on purpose. The registry matches loosely ("work"
reaches the schedule), and a wrong instant answer is worse than a slower right
one. A desk's own questions name other people and sites, so only its tapped
suggestions are instant.

Without the key, every question is answered by the registry, as before. With it, a model failure (timeout, outage) still falls back to the
registry.

Each answer records its `tier` on the assistant's trail and the audit log
(`hugo.asked`), with the intent and the tools and never the words. That shows
how many questions each model answers, and so the spend.

## Live answers: `POST /hugo/ask/stream`

The body is the same as `POST /hugo/ask`. The response is newline-delimited JSON
(`application/x-ndjson`), one `HugoAskEvent` per line (`packages/shared/src/hugoWork.ts`):

| Event | Meaning |
| --- | --- |
| `{ t: 'step', step }` | A tool is about to read something: `schedule`, `pay`, `ride`, `documents`, `desk`, `coverage`, `help`, `report`, `team`, `action`, `person` or `records`. The app words it (`hugoPane.step.*`, six languages); tool names never reach the screen |
| `{ t: 'text', d }` | Words of the reply as the model writes them |
| `{ t: 'clear' }` | What was written so far led in to a tool call ("let me check"): drop it |
| `{ t: 'done', answer }` | The whole answer, the same body `/hugo/ask` returns. This is the one to keep |
| `{ t: 'error', message }` | It failed after words were on the screen |

- The stream opens with its first line. A refusal before anything is said (no
  assistant for the account, switched off, a bad body) is an ordinary JSON
  error with its status.
- `Cache-Control: no-transform` keeps `compression()` from buffering it, and
  `X-Accel-Buffering: no` asks proxies not to buffer it either.
- When the person goes away, the model call is aborted.

**In the app:**
- `askHugo(text, { onEvent })` in `lib/hugoApi.ts` reads the stream through
  `apiStream` (`lib/api.ts`).
- When the stream itself is the problem (an older server answering 404, or a
  browser that can't read a stream), it asks the plain way. A refusal is never
  asked twice.
- The panel shows the step in its status line and in the waiting bubble, then
  his words with a caret as they arrive. The finished answer replaces them, and
  a screen reader hears only the finished answer.
- The panel also shares the step through `assistantContext.live`. The Home card
  then reads "Checking the schedule…", and the top-bar and phone faces put his
  headphones on (`hugoMood` → `answering`).

## Associates' Hugo never calls the model

The owner, 2026-10-30: "the associates Hugo should not be connected to deep seek".
An account whose role, or the hat it is wearing, is in `HUGO_MODEL_OFF_ROLES`
(`ASSOCIATE` by default) is answered by the registry everywhere: the app's chat
(plain and streamed), WhatsApp, and their repeats. Nothing of theirs reaches the
provider.

- **Every way in asks** `modelAvailableFor(user)` (`lib/hugoModelGate.ts`):
  `GET /hugo` answers `model: false`, so the app offers no goals, no free-question
  repeats, no allowance meter and no "What Hugo knows". `/hugo/allowance` answers
  `on: false`.
- **The hard stop:** `runModelLoop` refuses the call with `HugoNoModelError` before
  anything is sent, and an account that can't be found counts as an associate's.
- **What was set up before the change:** an associate's open goal stops at its next
  step (`FAILED`, `no_access`), and a free-question repeat at its next run
  (`FAILED`, `not_available`, with the "I've stopped" notice). Their other repeats
  (payday, shifts, hours) carry on, because the registry answers them.
- **Memory:** an associate can't add or change facts (409 `hugo_no_memory`), but
  can still read and remove what is already kept.
- **Supervisors, drivers and the office** keep the model and their allowances.

## Each person's allowance (`lib/hugoAllowance.ts`)

Every account has its own Hugo, and every model call is charged to the person it
was for: a chat answer, a goal's step, a recurring brief or a WhatsApp reply. Each
call writes one `HugoUsage` row with its tokens and its cost in millionths of a
dollar, never the words.

| Who | Allowance | Period |
| --- | --- | --- |
| Drivers, floor and shift supervisors (associates have no model calls) | $1 | A 30-day cycle that begins with their first use (`HugoProfile.allowanceCycleStartedAt`); used up, they wait for the cycle to end |
| Everyone else Hugo serves (the office) | $10 | The company's calendar month; used up, they wait for the next month |

- **Before each call:** `assertAllowance` refuses the call with `HugoAllowanceError`
  (which carries `renewsAt`) once the period's sum reaches the cap.
- **Then:** the chat answers from the registry and appends `allowanceUsedLine` in
  the person's language. Payday, shifts, ride, documents and the desk always work,
  because they cost nothing.
- **Overshoot:** a call is allowed while anything is left, so the last one can go
  over by its own cost, about a cent.
- **Prices:** `HUGO_PRICE_FAST` and `HUGO_PRICE_DEEP` are "input, cached input,
  output" in dollars per million tokens. They default to DeepSeek's peak rates
  (October 2026), so the allowance never under-counts.
- **What the person sees:** `GET /hugo/allowance` gives the share used and the
  renewal date, plus dollars for the office only.

## Settings

- `Hugo` (or `DEEPSEEK_API_KEY`): the model's key. Unset means the registry only.
- `ASSISTANT_BASE_URL`: the provider's Anthropic-compatible endpoint.
- `ASSISTANT_MODEL`: the strongest model, for actions and numbers.
- `ASSISTANT_FAST_MODEL`: the quick model, for everyday questions.
- `HUGO_PRICE_FAST`, `HUGO_PRICE_DEEP`: the prices the allowance is charged at.
- `HUGO_ALLOWANCE_FLOOR_USD` (1) and `HUGO_ALLOWANCE_STAFF_USD` (10): the monthly allowances.
- `HUGO_MODEL_OFF_ROLES` (`ASSOCIATE`): roles whose Hugo never calls the model, comma-separated.

## Tuning

- Widen the instant path by adding an intent to `SELF_SERVE`. A word that
  should always reach a model goes in `JUDGMENT`.
- Change what counts as an action or a report with `ACTION` and `NUMBERS`.
- Every rule has a case in `src/__tests__/lib/hugoRouting.test.ts`.
