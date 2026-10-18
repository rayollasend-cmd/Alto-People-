import http2 from 'node:http2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { logger } from './logger.js';

/**
 * Push to the native apps (apps/mobile): APNs for iOS, FCM for Android.
 *
 * Called from sendPushToUser (lib/webPush.ts), which every notification
 * path already funnels through AFTER quiet hours / digest decisions — so a
 * phone obeys the same delivery preferences the web push does.
 *
 *   - Unconfigured platform → that platform is a quiet no-op (dev / test).
 *   - A token the service says is gone (APNs 410 / BadDeviceToken, FCM
 *     UNREGISTERED / 404) is cleared from the device row, so the table
 *     cleans itself as apps are uninstalled.
 *   - Never throws: push must not fail the action that caused it.
 */

export interface NativePushMessage {
  title: string;
  body: string;
  /** In-app path the notification opens. */
  url?: string;
}

export type SendResult = 'sent' | 'gone' | 'failed';

/** The transports, swappable in tests. */
export interface NativeTransports {
  apns(token: string, msg: NativePushMessage): Promise<SendResult>;
  fcm(token: string, msg: NativePushMessage): Promise<SendResult>;
}

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, '\n') : undefined);

export function apnsConfigured(): boolean {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY);
}

export function fcmConfigured(): boolean {
  return Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY);
}

/* ----- APNs (HTTP/2, token auth) ------------------------------------------ */

let apnsJwt: { token: string; at: number } | null = null;

function apnsAuthToken(): string {
  // Apple accepts a provider token for up to an hour and rejects refreshing
  // more than once every 20 minutes — reuse for 50.
  if (apnsJwt && Date.now() - apnsJwt.at < 50 * 60_000) return apnsJwt.token;
  const token = jwt.sign({ iss: env.APNS_TEAM_ID }, pem(env.APNS_PRIVATE_KEY)!, {
    algorithm: 'ES256',
    keyid: env.APNS_KEY_ID,
  });
  apnsJwt = { token, at: Date.now() };
  return token;
}

async function sendApns(token: string, msg: NativePushMessage): Promise<SendResult> {
  const host = env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const payload = JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': 'alto' },
    ...(msg.url ? { url: msg.url } : {}),
  });
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* closing */
      }
      resolve(r);
    };
    const client = http2.connect(host);
    client.on('error', () => done('failed'));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsAuthToken()}`,
      'apns-topic': env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.setTimeout(10_000, () => {
      req.close();
      done('failed');
    });
    req.on('response', (h) => {
      status = Number(h[':status'] ?? 0);
    });
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (status === 200) return done('sent');
      const reason = (() => {
        try {
          return (JSON.parse(body) as { reason?: string }).reason ?? '';
        } catch {
          return '';
        }
      })();
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return done('gone');
      logger.warn({ status, reason }, 'APNs push failed');
      done('failed');
    });
    req.on('error', () => done('failed'));
    req.end(payload);
  });
}

/* ----- FCM (HTTP v1, service-account OAuth) ------------------------------- */

let fcmAccess: { token: string; exp: number } | null = null;

async function fcmAccessToken(): Promise<string | null> {
  if (fcmAccess && fcmAccess.exp - Date.now() > 60_000) return fcmAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: env.FCM_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    pem(env.FCM_PRIVATE_KEY)!,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) {
    logger.warn({ status: res.status }, 'FCM token exchange failed');
    return null;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  fcmAccess = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function sendFcm(token: string, msg: NativePushMessage): Promise<SendResult> {
  const access = await fcmAccessToken();
  if (!access) return 'failed';
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        data: msg.url ? { url: msg.url } : {},
        android: { priority: 'high', notification: { channel_id: 'alto_default', icon: 'ic_stat_alto', color: '#D9B967' } },
      },
    }),
  });
  if (res.ok) return 'sent';
  const text = await res.text().catch(() => '');
  if (res.status === 404 || text.includes('UNREGISTERED')) return 'gone';
  logger.warn({ status: res.status }, 'FCM push failed');
  return 'failed';
}

let transports: NativeTransports = { apns: sendApns, fcm: sendFcm };

/** Tests: replace the network senders (returns the previous ones). */
export function setNativeTransportsForTests(next: Partial<NativeTransports> & { force?: boolean }): NativeTransports {
  const prev = transports;
  transports = { ...transports, ...next };
  forceConfigured = next.force ?? forceConfigured;
  return prev;
}
let forceConfigured = false;

/** Send to every phone this person has the app on (with notifications allowed). */
export async function sendNativePushToUser(userId: string, msg: NativePushMessage): Promise<number> {
  const ios = forceConfigured || apnsConfigured();
  const android = forceConfigured || fcmConfigured();
  if (!ios && !android) return 0;
  try {
    const devices = await prisma.nativeDevice.findMany({
      where: { userId, revokedAt: null, pushToken: { not: null } },
      select: { id: true, platform: true, pushToken: true },
    });
    let sent = 0;
    await Promise.all(
      devices.map(async (d) => {
        if (d.platform === 'IOS' && !ios) return;
        if (d.platform === 'ANDROID' && !android) return;
        const result = d.platform === 'IOS' ? await transports.apns(d.pushToken!, msg) : await transports.fcm(d.pushToken!, msg);
        if (result === 'sent') sent += 1;
        if (result === 'gone') {
          await prisma.nativeDevice.update({ where: { id: d.id }, data: { pushToken: null } }).catch(() => {});
        }
      }),
    );
    return sent;
  } catch (err) {
    logger.warn({ err }, 'native push failed');
    return 0;
  }
}
