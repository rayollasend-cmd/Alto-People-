import { unlink } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from './audit.js';
import { purgeAssociateBiometrics } from './kioskMaintenance.js';
import { resolveStoragePath } from './storage.js';
import { logger } from './logger.js';

/**
 * Admin-initiated associate erasure (privacy / right-to-deletion).
 *
 * Design principle: PAYROLL AND TAX RECORDS ARE LEGALLY RETAINED — the
 * IRS wants employment tax records for 4 years, the FLSA wants payroll
 * records for 3. So this is "anonymize + scrub", never row deletion:
 *
 *   KEPT (untouched)     TimeEntry, PayrollItem, PayrollRun, Shift
 *                        assignments, W-4 numeric elections, DocumentRecord
 *                        rows (kind + timestamps as evidence they existed),
 *                        KioskPunch rows (minus selfies), Notification rows
 *                        (minus content).
 *   ANONYMIZED           Associate identity fields, linked User account.
 *   SCRUBBED / DELETED   SSN + TIN ciphertext, bank account/routing
 *                        ciphertext, document blobs on disk, kiosk
 *                        biometrics (selfies + face template) and PIN
 *                        credentials, emergency contacts, login
 *                        credentials (password, MFA, passkeys, tokens).
 *
 * Refusal policy:
 *   - 409 `payroll_in_flight` while the associate has items on a DRAFT or
 *     FINALIZED payroll run — erasing mid-run would disburse pay against a
 *     half-anonymized record. Never overridable, not even with `force`.
 *   - 409 `not_terminated` unless the associate is already soft-deleted
 *     (Associate.deletedAt set — the product's "separated" marker) OR the
 *     caller passes `force: true` for the edge cases (wrong-person record,
 *     regulator demand before offboarding paperwork). A forced erasure of a
 *     live associate also stamps deletedAt: an erased identity cannot keep
 *     working shifts.
 *   - 409 `already_erased` when erasedAt is already set (idempotence guard —
 *     re-running would produce misleading zero-count audit rows).
 *
 * The critical audit row (`privacy.associate_erased`) is written AFTER the
 * transaction commits, record-then-fail: erasure is irreversible, so if the
 * audit insert fails we surface the failure loudly (500) rather than let
 * the erasure go unrecorded — matching the payroll-disbursement pattern in
 * lib/audit.ts. Metadata carries the reason + per-category counts, never
 * the erased values themselves.
 */

export interface ErasureResult {
  associateId: string;
  erasedAt: Date;
  counts: {
    userDisabled: number;
    passkeysDeleted: number;
    mfaRecoveryCodesDeleted: number;
    authTokensDeleted: number;
    pushSubscriptionsDeleted: number;
    w4SsnCleared: number;
    payoutMethodsScrubbed: number;
    documentsSoftDeleted: number;
    documentBlobsUnlinked: number;
    emergencyContactsDeleted: number;
    kioskPinsDeleted: number;
    kioskSelfiesPurged: number;
    faceReferenceCleared: number;
    notificationsScrubbed: number;
  };
}

const ERASED_EMAIL_DOMAIN = 'invalid.local';

export async function eraseAssociate(
  prisma: PrismaClient,
  associateId: string,
  actorUserId: string,
  reason: string,
  opts: { force?: boolean } = {},
): Promise<ErasureResult> {
  const associate = await prisma.associate.findUnique({
    where: { id: associateId },
    select: {
      id: true,
      email: true,
      deletedAt: true,
      erasedAt: true,
      photoS3Key: true,
      user: { select: { id: true, tokenVersion: true } },
      documents: {
        where: { deletedAt: null },
        select: { id: true, s3Key: true },
      },
    },
  });
  if (!associate) {
    throw new HttpError(404, 'not_found', 'Associate not found.');
  }
  if (associate.erasedAt) {
    throw new HttpError(
      409,
      'already_erased',
      'This associate has already been erased.',
    );
  }

  // Hard block, force cannot override: an item on a run that has not yet
  // been disbursed (or cancelled) still needs the associate's identity for
  // pay computation, disbursement files and paystubs.
  const inFlightItems = await prisma.payrollItem.count({
    where: {
      associateId,
      payrollRun: { status: { in: ['DRAFT', 'FINALIZED'] } },
    },
  });
  if (inFlightItems > 0) {
    throw new HttpError(
      409,
      'payroll_in_flight',
      'This associate has pay items on a payroll run that is still in flight. Disburse or cancel the run first.',
    );
  }

  if (!associate.deletedAt && !opts.force) {
    throw new HttpError(
      409,
      'not_terminated',
      'This associate is not marked separated. Complete their separation first, or pass force to erase anyway.',
    );
  }

  const now = new Date();
  const last6 = associate.id.replace(/-/g, '').slice(-6);
  // Blobs to unlink from disk after the DB transaction commits.
  const blobKeys = associate.documents
    .map((d) => d.s3Key)
    .filter((k): k is string => k !== null);
  if (associate.photoS3Key) blobKeys.push(associate.photoS3Key);

  const counts: ErasureResult['counts'] = {
    userDisabled: 0,
    passkeysDeleted: 0,
    mfaRecoveryCodesDeleted: 0,
    authTokensDeleted: 0,
    pushSubscriptionsDeleted: 0,
    w4SsnCleared: 0,
    payoutMethodsScrubbed: 0,
    documentsSoftDeleted: 0,
    documentBlobsUnlinked: 0,
    emergencyContactsDeleted: 0,
    kioskPinsDeleted: 0,
    kioskSelfiesPurged: 0,
    faceReferenceCleared: 0,
    notificationsScrubbed: 0,
  };

  await prisma.$transaction(async (tx) => {
    // --- Associate identity fields -> anonymized in place ------------------
    // Associate.email is NOT NULL + unique, so it becomes a per-row
    // impossible address instead of null.
    await tx.associate.update({
      where: { id: associateId },
      data: {
        firstName: 'Erased',
        lastName: `Associate-${last6}`,
        middleInitial: null,
        otherLastNames: [],
        dob: null,
        email: `erased+${associateId}@${ERASED_EMAIL_DOMAIN}`,
        phone: null,
        ssnLast4: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        zip: null,
        tinEncrypted: null,
        photoS3Key: null,
        photoUpdatedAt: null,
        faceConsentStatus: null,
        faceConsentAt: null,
        erasedAt: now,
        erasedById: actorUserId,
        // A force-erased live associate is separated by definition.
        ...(associate.deletedAt ? {} : { deletedAt: now }),
      },
    });

    // Emergency contacts are third-party PII with no retention duty —
    // delete the rows outright rather than nulling NOT NULL name/phone.
    const contacts = await tx.emergencyContact.deleteMany({
      where: { associateId },
    });
    counts.emergencyContactsDeleted = contacts.count;

    // --- Linked login (if any) ---------------------------------------------
    if (associate.user) {
      const userId = associate.user.id;
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DISABLED',
          email: `erased+${userId}@${ERASED_EMAIL_DOMAIN}`,
          passwordHash: null,
          // Kill every live session.
          tokenVersion: { increment: 1 },
          mfaSecretEncrypted: null,
          mfaEnabledAt: null,
          deletedAt: now,
        },
      });
      counts.userDisabled = 1;
      // Sequential on purpose — a TransactionClient must not run queries
      // in parallel.
      const passkeys = await tx.webAuthnCredential.deleteMany({ where: { userId } });
      const recovery = await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      const invites = await tx.inviteToken.deleteMany({ where: { userId } });
      const resets = await tx.passwordResetToken.deleteMany({ where: { userId } });
      const emailChanges = await tx.emailChangeRequest.deleteMany({ where: { userId } });
      const pushes = await tx.pushSubscription.deleteMany({ where: { userId } });
      counts.passkeysDeleted = passkeys.count;
      counts.mfaRecoveryCodesDeleted = recovery.count;
      counts.authTokensDeleted = invites.count + resets.count + emailChanges.count;
      counts.pushSubscriptionsDeleted = pushes.count;

      // Notifications: null the content, keep the rows + categories so
      // delivery accounting (e.g. campaign send history) still adds up.
      // Chosen over deleting recipient rows because several surfaces count
      // sends per category; body is NOT NULL so it becomes ''.
      const notifs = await tx.notification.updateMany({
        where: {
          OR: [
            { recipientUserId: userId },
            { recipientEmail: associate.email },
          ],
        },
        data: {
          subject: null,
          body: '',
          recipientEmail: null,
          recipientPhone: null,
        },
      });
      counts.notificationsScrubbed = notifs.count;
    } else {
      // No login — still scrub notifications addressed to the raw email.
      const notifs = await tx.notification.updateMany({
        where: { recipientEmail: associate.email },
        data: {
          subject: null,
          body: '',
          recipientEmail: null,
          recipientPhone: null,
        },
      });
      counts.notificationsScrubbed = notifs.count;
    }

    // --- Tax / pay identity ciphertext -------------------------------------
    // W-4 numeric elections (filing status, dependents, withholding) stay —
    // they are part of the retained payroll history. Only the SSN goes.
    const w4 = await tx.w4Submission.updateMany({
      where: { associateId, ssnEncrypted: { not: null } },
      data: { ssnEncrypted: null },
    });
    counts.w4SsnCleared = w4.count;

    const payout = await tx.payoutMethod.updateMany({
      where: { associateId },
      data: {
        accountNumberEnc: null,
        routingNumberEnc: null,
        bankName: null,
        branchCardId: null,
      },
    });
    counts.payoutMethodsScrubbed = payout.count;

    // --- Documents: soft-delete rows, drop blob pointers -------------------
    // Rows stay (kind + timestamps) as evidence the documents existed;
    // the files themselves are unlinked from disk after commit.
    const docs = await tx.documentRecord.updateMany({
      where: { associateId, deletedAt: null },
      data: { deletedAt: now, s3Key: null },
    });
    counts.documentsSoftDeleted = docs.count;

    // --- Kiosk biometrics + PIN credential ---------------------------------
    const bio = await purgeAssociateBiometrics(tx, associateId);
    counts.kioskSelfiesPurged = bio.selfiesPurged;
    counts.faceReferenceCleared = bio.faceReferenceCleared ? 1 : 0;
    const pins = await tx.kioskPin.deleteMany({ where: { associateId } });
    counts.kioskPinsDeleted = pins.count;
  }, {
    // ~18 sequential statements; over a high-latency serverless Postgres
    // link the default 5s interactive-transaction budget is too tight.
    maxWait: 10_000,
    timeout: 30_000,
  });

  // Blob unlink is best-effort, outside the transaction (fs is not
  // transactional): the DB no longer points at these files either way.
  for (const key of blobKeys) {
    try {
      await unlink(resolveStoragePath(key));
      counts.documentBlobsUnlinked += 1;
    } catch (err) {
      logger.warn(
        { err, associateId, key },
        'erasure: document blob unlink failed (already gone?)',
      );
    }
  }

  // Provable record — throws (and thus fails the request) if it cannot be
  // written. No PII in the metadata: the reason is the admin's own words,
  // counts are numbers, and the entityId is the (now anonymized) row id.
  await recordCriticalAudit(
    {
      actorUserId,
      action: 'privacy.associate_erased',
      entityType: 'Associate',
      entityId: associateId,
      metadata: {
        reason,
        forced: opts.force === true,
        counts,
      },
    },
    'erasure.eraseAssociate',
  );

  return { associateId, erasedAt: now, counts };
}
