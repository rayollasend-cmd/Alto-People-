import { HUGO_GOAL_MAX_CHARS, type HugoTaskOffer } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import type { AssistantTool } from './assistantModel.js';
import { cleanGoal } from './hugoGoals.js';
import { previewHugoTask } from './hugoTasks.js';

/**
 * Handing Hugo a goal from the chat (lib/hugoGoals): when the person asks for
 * an OUTCOME that takes time or several steps — not a question — the model
 * may offer one. The tool records the offer only: the answer carries a Start
 * card (the same HugoTaskOffer as every task), and nothing starts until the
 * person taps it. One goal offer an answer.
 */
export function offerGoalTool(user: SessionUser, offers: HugoTaskOffer[], now: Date = new Date()): AssistantTool {
  return {
    key: 'OFFER_GOAL',
    name: 'offer_goal',
    description:
      'Offer to take on a GOAL for the person in the background: an outcome that takes time or several steps, which you would plan, watch and work on over days, proposing each step for them to approve ("get me 40 hours next week", "keep my documents current", for a scheduling desk "keep tomorrow fully staffed"). Not for a question you can answer now, and not for a single action you can propose. This only shows a Start card; nothing starts until they tap Start. goal: the outcome in their words, in their language, under 300 characters.',
    input: { properties: { goal: { type: 'string', description: 'The outcome, in their words.' } }, required: ['goal'] },
    run: async (args) => {
      if (offers.length >= 1) return { reply: 'A goal is already offered on the screen; do not offer another.', linkUrl: null };
      const goal = String(args?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, HUGO_GOAL_MAX_CHARS);
      if (goal.length < 3) return { reply: 'Say the goal in a few words.', linkUrl: null };
      const task = cleanGoal({ kind: 'GOAL' as const, goal });
      try {
        const subject = await previewHugoTask(user, task, now);
        if (!subject) return { reply: 'A goal cannot be started for them right now (they may already have three open, or their allowance is used up). Tell them plainly; do not offer it.', linkUrl: null };
        offers.push({ task, subject });
        return { reply: 'A Start card is on the screen. Nothing starts until they tap Start; say in one short sentence what you will work toward and that you will check with them before changing anything.', linkUrl: null };
      } catch (err) {
        if (err instanceof HttpError) return { reply: `Could not offer it: ${err.message}`, linkUrl: null };
        throw err;
      }
    },
  };
}
