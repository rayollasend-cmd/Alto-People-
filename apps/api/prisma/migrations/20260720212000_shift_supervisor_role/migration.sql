-- Client-scoped floor supervisor role: manages scheduling + time for one
-- client's associates only (scoping enforced via User.clientId + scope*).
ALTER TYPE "Role" ADD VALUE 'SHIFT_SUPERVISOR';
