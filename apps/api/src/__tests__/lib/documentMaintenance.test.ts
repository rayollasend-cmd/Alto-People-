import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAssociate, prisma, truncateAll } from '../../../test/db.js';
import { resolveStoragePath } from '../../lib/storage.js';
import {
  REJECTED_DOC_RETENTION_DAYS,
  purgeRejectedDocs,
} from '../../lib/documentMaintenance.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

async function seedRejected(opts: {
  rejectedAt: Date;
}): Promise<{ docId: string; s3Key: string; path: string }> {
  const associate = await createAssociate();
  const s3Key = `${crypto.randomUUID()}-test.png`;
  const path = resolveStoragePath(s3Key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, TINY_PNG);
  const doc = await prisma.documentRecord.create({
    data: {
      associateId: associate.id,
      kind: 'ID',
      s3Key,
      filename: 'license.png',
      mimeType: 'image/png',
      size: TINY_PNG.length,
      status: 'REJECTED',
      rejectionReason: 'unreadable',
      verifiedAt: opts.rejectedAt,
    },
  });
  return { docId: doc.id, s3Key, path };
}

describe('purgeRejectedDocs', () => {
  it('purges a REJECTED doc whose verifiedAt is past the retention window', async () => {
    const longAgo = new Date(
      Date.now() - (REJECTED_DOC_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const { docId, path } = await seedRejected({ rejectedAt: longAgo });
    expect(existsSync(path)).toBe(true);

    const result = await purgeRejectedDocs();
    expect(result.purged).toBe(1);
    expect(existsSync(path)).toBe(false);

    const after = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: docId },
    });
    // Row stays for audit; only the blob and s3Key reference go.
    expect(after.status).toBe('REJECTED');
    expect(after.s3Key).toBeNull();
    expect(after.rejectionReason).toBe('unreadable');
  });

  it('leaves a REJECTED doc alone while still inside the retention window', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { docId, path } = await seedRejected({ rejectedAt: yesterday });

    const result = await purgeRejectedDocs();
    expect(result.purged).toBe(0);
    expect(existsSync(path)).toBe(true);

    const after = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: docId },
    });
    expect(after.s3Key).not.toBeNull();
  });

  it('handles a row whose blob is already missing from disk', async () => {
    // Simulates a Railway redeploy that wiped uploads but left the row.
    const longAgo = new Date(
      Date.now() - (REJECTED_DOC_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const associate = await createAssociate();
    const doc = await prisma.documentRecord.create({
      data: {
        associateId: associate.id,
        kind: 'ID',
        s3Key: 'missing-file.png',
        filename: 'license.png',
        mimeType: 'image/png',
        size: 100,
        status: 'REJECTED',
        rejectionReason: 'unreadable',
        verifiedAt: longAgo,
      },
    });

    const result = await purgeRejectedDocs();
    expect(result.purged).toBe(1);
    expect(result.errors).toEqual([]);

    const after = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(after.s3Key).toBeNull();
  });
});
