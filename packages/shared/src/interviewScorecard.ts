import { z } from 'zod';

/**
 * A structured scorecard: every kit question rated on the same four-point
 * scale (SCORECARD_RATINGS in ./contracts.ts), with notes, plus an overall
 * summary.
 *
 * A module of its own so the web's one runtime use (reading a stored
 * scorecard) doesn't put zod into the chunk of plain constants from
 * ./contracts.ts that some forty pages share.
 */
export const InterviewScorecardSchema = /* @__PURE__ */ (() => z.object({
  answers: z
    .array(
      z.object({
        prompt: z.string().min(1).max(1000),
        rating: z.number().int().min(1).max(4).nullable(),
        notes: z.string().max(4000),
      }),
    )
    .max(50),
  summary: z.string().max(8000),
}))();
export type InterviewScorecard = z.infer<typeof InterviewScorecardSchema>;
