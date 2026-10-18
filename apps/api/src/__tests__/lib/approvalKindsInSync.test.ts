import { describe, expect, it } from 'vitest';
import { ApprovalRequestKind } from '@prisma/client';
import { APPROVAL_REQUEST_KIND_LABELS, ApprovalRequestKindSchema } from '@alto-people/shared';

/**
 * Every kind the database can hold must be one the API's response schema
 * accepts — a kind added to the enum alone made every approvals list that
 * held one fail validation.
 */
describe('approval request kinds', () => {
  it('the shared schema and labels cover every database kind', () => {
    const db = Object.values(ApprovalRequestKind).sort();
    expect([...ApprovalRequestKindSchema.options].sort()).toEqual(db);
    for (const k of db) expect(APPROVAL_REQUEST_KIND_LABELS[k as keyof typeof APPROVAL_REQUEST_KIND_LABELS], k).toBeTruthy();
  });
});
