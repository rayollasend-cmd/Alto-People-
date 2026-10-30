# Hugo: fast answers, live answers

Built 2026-10-29. The owner asked for Hugo to work more like Meta's Muse: answers
that come quickly, cost little, and show what he is doing while he works.

## Three ways to answer, quickest first

`apps/api/src/lib/hugoRouting.ts` picks one per question.

| Tier | What answers | When |
| --- | --- | --- |
| `instant` | The registry (`lib/hugo`), no model | A suggestion tapped (the registry's own example question), or a worker's or driver's short question (7 words or fewer) about their own payday, shifts, ride or documents, with no word of judgment in it ("why", "wrong", "didn't", "how much", "swap", "late"…) |
| `fast` | `ASSISTANT_FAST_MODEL` (default `claude-haiku-5-5`), no extended thinking, 800 tokens | Everything else: everyday questions |
| `deep` | `ASSISTANT_MODEL` (default `claude-opus-5-5`), adaptive thinking at medium effort, 1,200 tokens | An action to set up (the person has `propose_*` tools and the words ask for one), numbers to run (the person has the report tool and the words ask how many, totals, by month…), several questions at once, or a long story |

The instant path is narrow on purpose. The registry matches loosely ("work"
reaches the schedule), and a wrong instant answer is worse than a slower right
one. A desk's own questions name other people and sites, so only its tapped
suggestions are instant.

Without `ANTHROPIC_API_KEY`, every question is answered by the registry, as
before. With it, a model failure (timeout, outage) still falls back to the
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

## Settings

- `ANTHROPIC_API_KEY`: unset means the registry only.
- `ASSISTANT_MODEL`: the strongest model, for actions and numbers.
- `ASSISTANT_FAST_MODEL`: the quick model, for everyday questions.

## Tuning

- Widen the instant path by adding an intent to `SELF_SERVE`. A word that
  should always reach a model goes in `JUDGMENT`.
- Change what counts as an action or a report with `ACTION` and `NUMBERS`.
- Every rule has a case in `src/__tests__/lib/hugoRouting.test.ts`.
