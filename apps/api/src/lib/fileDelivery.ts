import { decryptString, encryptString } from './crypto.js';

/**
 * Sending a file to a partner: a recordkeeper's contribution file, a
 * carrier's 834. Three ways:
 *
 *   DOWNLOAD  nothing is sent; Finance downloads the file and uploads it in
 *             the partner's portal. Always available.
 *   HTTPS     POST to the partner's file endpoint with a bearer key.
 *   SFTP      put the file in the partner's drop folder. The SFTP client
 *             (`ssh2-sftp-client`) is loaded at run time only when present;
 *             the API does not ship it, so until it is installed an SFTP
 *             send fails plainly and the file stays ready to download.
 *
 * Connection settings are stored encrypted (AES-GCM field encryption,
 * lib/crypto) as base64; only `describeConnection` output reaches a page.
 */

export type Transport = 'DOWNLOAD' | 'HTTPS' | 'SFTP';

export interface ConnectionSettings {
  /** HTTPS */
  baseUrl?: string;
  apiKey?: string;
  /** SFTP */
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  remoteDir?: string;
  /** SFTP: the carrier's folder for its answers (999 / TA1); unset = no pickup (lib/carrierAcks). */
  inboundDir?: string;
}

export function sealConnection(c: ConnectionSettings): string {
  return encryptString(JSON.stringify(c)).toString('base64');
}

export function openConnection(enc: string | null | undefined): ConnectionSettings {
  if (!enc) return {};
  try {
    return JSON.parse(decryptString(Buffer.from(enc, 'base64'))) as ConnectionSettings;
  } catch {
    return {};
  }
}

/** What a page may show: where it goes, never the secret. */
export function describeConnection(enc: string | null | undefined): { host: string | null; username: string | null; remoteDir: string | null; inboundDir: string | null; baseUrl: string | null; hasSecret: boolean } {
  const c = openConnection(enc);
  return {
    host: c.host ?? null,
    username: c.username ?? null,
    remoteDir: c.remoteDir ?? null,
    inboundDir: c.inboundDir ?? null,
    baseUrl: c.baseUrl ?? null,
    hasSecret: !!(c.password || c.privateKey || c.apiKey),
  };
}

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** The part of ssh2-sftp-client this file and lib/carrierAcks use. */
export interface SftpClient {
  connect(o: Record<string, unknown>): Promise<unknown>;
  put(input: Buffer, remotePath: string): Promise<unknown>;
  /** A folder's entries: type '-' is a file. */
  list(remoteDir: string): Promise<Array<{ type: string; name: string; size: number; modifyTime: number }>>;
  /** A file's bytes. */
  get(remotePath: string): Promise<Buffer | string | NodeJS.WritableStream>;
  end(): Promise<unknown>;
}

/** Overridable in tests. */
export const deliveryDeps = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  async loadSftp(): Promise<(new () => SftpClient) | null> {
    const name = 'ssh2-sftp-client';
    try {
      const mod = (await import(name)) as { default: new () => SftpClient };
      return mod.default;
    } catch {
      return null;
    }
  },
};

/** Send one file. Returns a reference (remote path or the partner's id). */
export async function deliverFile(transport: Transport, connection: ConnectionSettings, fileName: string, content: string, contentType = 'text/plain'): Promise<{ reference: string }> {
  if (transport === 'DOWNLOAD') throw new DeliveryError('This connection is set to download: get the file and upload it in the partner’s portal.');
  if (transport === 'HTTPS') {
    if (!connection.baseUrl || !connection.apiKey) throw new DeliveryError('The connection needs the partner’s file address and key.');
    const res = await deliveryDeps.fetch(connection.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': contentType, 'X-File-Name': fileName },
      body: content,
    });
    if (!res.ok) throw new DeliveryError(`The partner refused the file (HTTP ${res.status}).`);
    let ref = fileName;
    try {
      const body = (await res.json()) as { id?: string; fileId?: string };
      ref = body.id ?? body.fileId ?? fileName;
    } catch {
      /* a body is optional */
    }
    return { reference: ref };
  }
  if (!connection.host || !connection.username || !(connection.password || connection.privateKey)) {
    throw new DeliveryError('The SFTP connection needs a host, a user name and a password or key.');
  }
  const Client = await deliveryDeps.loadSftp();
  if (!Client) throw new DeliveryError('SFTP sending is not installed on this server yet. Download the file and upload it; the file is ready.');
  const client = new Client();
  const remote = `${(connection.remoteDir ?? '').replace(/\/$/, '')}/${fileName}`;
  try {
    await client.connect({ host: connection.host, port: connection.port ?? 22, username: connection.username, password: connection.password, privateKey: connection.privateKey });
    await client.put(Buffer.from(content, 'utf8'), remote);
  } catch (err) {
    throw new DeliveryError(`SFTP upload failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return { reference: remote };
}
