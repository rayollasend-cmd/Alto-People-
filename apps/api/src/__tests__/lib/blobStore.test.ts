import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

// Mocked S3 client: records constructor configs and every command sent, so
// the S3 driver tests assert exact parameter shapes without any network.
const s3State = vi.hoisted(() => ({
  ctorConfigs: [] as unknown[],
  sent: [] as Array<{ type: string; input: Record<string, unknown> }>,
  // Per-test response/throw hook; default resolves {}.
  responder: undefined as
    | undefined
    | ((type: string, input: Record<string, unknown>) => unknown),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    constructor(
      public readonly type: string,
      public readonly input: Record<string, unknown>,
    ) {}
  }
  const make = (type: string) =>
    class extends Cmd {
      constructor(input: Record<string, unknown>) {
        super(type, input);
      }
    };
  class S3Client {
    constructor(cfg: unknown) {
      s3State.ctorConfigs.push(cfg);
    }
    async send(cmd: Cmd): Promise<unknown> {
      s3State.sent.push({ type: cmd.type, input: cmd.input });
      if (s3State.responder) return s3State.responder(cmd.type, cmd.input);
      return {};
    }
  }
  return {
    S3Client,
    PutObjectCommand: make('PutObject'),
    GetObjectCommand: make('GetObject'),
    HeadObjectCommand: make('HeadObject'),
    DeleteObjectCommand: make('DeleteObject'),
  };
});

import {
  LocalBlobStore,
  S3BlobStore,
  createBlobStore,
  blobExistsForListing,
} from '../../lib/blobStore.js';
import { resolveStoragePath } from '../../lib/storage.js';

const TEST_DIR = `blobstore-test-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await rm(resolveStoragePath(TEST_DIR), { recursive: true, force: true });
});

beforeEach(() => {
  s3State.ctorConfigs.length = 0;
  s3State.sent.length = 0;
  s3State.responder = undefined;
});

function missingError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('LocalBlobStore', () => {
  const store = new LocalBlobStore();

  it('round-trips put/get/exists/delete under UPLOAD_ROOT', async () => {
    const key = `${TEST_DIR}/nested/dir/roundtrip.txt`;
    const payload = Buffer.from('hello blob store');

    expect(await store.exists(key)).toBe(false);
    expect(await store.get(key)).toBeNull();

    // put creates intermediate directories.
    await store.put(key, payload, 'text/plain');
    expect(await store.exists(key)).toBe(true);
    expect(existsSync(resolveStoragePath(key))).toBe(true);
    expect((await store.get(key))!.equals(payload)).toBe(true);

    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    // delete is idempotent — second call resolves.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('rejects path-escape keys on every operation', async () => {
    const evil = '../escape-attempt.txt';
    await expect(store.put(evil, Buffer.from('x'), 'text/plain')).rejects.toThrow(
      'storage path escape attempt',
    );
    await expect(store.get(evil)).rejects.toThrow('storage path escape attempt');
    await expect(store.exists(evil)).rejects.toThrow('storage path escape attempt');
    await expect(store.delete(evil)).rejects.toThrow('storage path escape attempt');
  });
});

describe('S3BlobStore', () => {
  it('builds the client like uploadsBackup.ts (endpoint, path-style, credentials)', () => {
    void new S3BlobStore({
      bucket: 'b',
      region: 'us-west-004',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    });
    expect(s3State.ctorConfigs[0]).toEqual({
      region: 'us-west-004',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      // Custom endpoint => path-style by default.
      forcePathStyle: true,
    });

    // No endpoint, no credentials => default provider chain, virtual-host style.
    void new S3BlobStore({ bucket: 'b', region: 'us-east-1' });
    expect(s3State.ctorConfigs[1]).toEqual({
      region: 'us-east-1',
      forcePathStyle: false,
    });

    // Explicit override wins over the endpoint heuristic.
    void new S3BlobStore({
      bucket: 'b',
      region: 'r',
      endpoint: 'https://example.com',
      forcePathStyle: false,
    });
    expect(s3State.ctorConfigs[2]).toMatchObject({ forcePathStyle: false });
  });

  it('rejects half-configured static credentials', () => {
    expect(
      () => new S3BlobStore({ bucket: 'b', region: 'r', accessKeyId: 'only-half' }),
    ).toThrow(/must be set together/);
  });

  it('put sends PutObject with bucket, 1:1 key, body, and content type', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    const body = Buffer.from('%PDF-1.7');
    await store.put('esign/agr-1/abcd1234.pdf', body, 'application/pdf');
    expect(s3State.sent).toEqual([
      {
        type: 'PutObject',
        input: {
          Bucket: 'docs',
          Key: 'esign/agr-1/abcd1234.pdf',
          Body: body,
          ContentType: 'application/pdf',
        },
      },
    ]);
  });

  it('applies STORAGE_S3_PREFIX to every operation', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r', prefix: 'alto-uploads' });
    s3State.responder = (type) =>
      type === 'GetObject'
        ? { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
        : {};
    await store.put('a/b.png', Buffer.from('x'), 'image/png');
    await store.get('a/b.png');
    await store.exists('a/b.png');
    await store.delete('a/b.png');
    expect(s3State.sent.map((s) => [s.type, s.input.Key])).toEqual([
      ['PutObject', 'alto-uploads/a/b.png'],
      ['GetObject', 'alto-uploads/a/b.png'],
      ['HeadObject', 'alto-uploads/a/b.png'],
      ['DeleteObject', 'alto-uploads/a/b.png'],
    ]);
  });

  it('get returns the object bytes as a Buffer', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    s3State.responder = () => ({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const buf = await store.get('k');
    expect(buf).toBeInstanceOf(Buffer);
    expect([...buf!]).toEqual([1, 2, 3]);
  });

  it('get returns null for missing objects (NoSuchKey / NotFound / 404)', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    s3State.responder = () => {
      throw missingError('NoSuchKey');
    };
    expect(await store.get('missing')).toBeNull();
    s3State.responder = () => {
      throw Object.assign(new Error('404'), { $metadata: { httpStatusCode: 404 } });
    };
    expect(await store.get('missing')).toBeNull();
  });

  it('get rethrows non-missing errors', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    s3State.responder = () => {
      throw Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } });
    };
    await expect(store.get('k')).rejects.toThrow('boom');
  });

  it('exists maps HeadObject success/NotFound to true/false', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    expect(await store.exists('k')).toBe(true);
    s3State.responder = () => {
      throw missingError('NotFound');
    };
    expect(await store.exists('k')).toBe(false);
    s3State.responder = () => {
      throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    };
    await expect(store.exists('k')).rejects.toThrow('denied');
  });

  it('delete sends DeleteObject (idempotent by S3 semantics)', async () => {
    const store = new S3BlobStore({ bucket: 'docs', region: 'r' });
    await store.delete('gone/already');
    expect(s3State.sent).toEqual([
      { type: 'DeleteObject', input: { Bucket: 'docs', Key: 'gone/already' } },
    ]);
  });
});

describe('createBlobStore driver selection', () => {
  it('defaults to the local driver (STORAGE_DRIVER unset in tests)', () => {
    expect(createBlobStore()).toBeInstanceOf(LocalBlobStore);
    expect(createBlobStore({ driver: 'local' })).toBeInstanceOf(LocalBlobStore);
  });

  it('returns the S3 driver when fully configured', () => {
    const store = createBlobStore({ driver: 's3', bucket: 'b', region: 'r' });
    expect(store).toBeInstanceOf(S3BlobStore);
  });

  it('throws on driver=s3 with missing bucket/region', () => {
    expect(() => createBlobStore({ driver: 's3' })).toThrow(
      /STORAGE_S3_BUCKET and STORAGE_S3_REGION/,
    );
    expect(() => createBlobStore({ driver: 's3', bucket: 'b' })).toThrow(
      /STORAGE_S3_BUCKET and STORAGE_S3_REGION/,
    );
    expect(() => createBlobStore({ driver: 's3', region: 'r' })).toThrow(
      /STORAGE_S3_BUCKET and STORAGE_S3_REGION/,
    );
  });
});

describe('blobExistsForListing (local driver in tests)', () => {
  it('is false for null keys and missing files, true for present blobs', async () => {
    expect(blobExistsForListing(null)).toBe(false);
    const key = `${TEST_DIR}/listing-check.bin`;
    expect(blobExistsForListing(key)).toBe(false);
    const store = new LocalBlobStore();
    await store.put(key, Buffer.from('x'), 'application/octet-stream');
    expect(blobExistsForListing(key)).toBe(true);
  });
});
