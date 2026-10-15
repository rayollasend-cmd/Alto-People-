/**
 * Brief 2-2 — the labor rules engine (docs/labor-rules-investigation.md).
 *
 *   Step 1 (this): rule families, packs in code, resolution, evaluators with
 *   reason lines. Not wired to pay: nothing in the app calls it yet. Step 2
 *   stores the sets (LaborRuleSet), step 3 runs it in shadow beside today's
 *   code, step 4 switches pay per tenant after the owner signs the dry run.
 */
export * from './params.js';
export * from './packs.js';
export * from './resolve.js';
export * from './evaluate.js';
