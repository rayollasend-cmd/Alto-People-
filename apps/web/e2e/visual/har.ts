import fs from 'node:fs';

/**
 * HAR clean-up for the visual suite's recordings (record.spec.ts).
 *
 * A recording keeps only what the replay matches on (method, URL, request
 * body) and what it answers with (status, content type, body). Everything
 * else goes: cookies, Authorization and Set-Cookie (a session must never
 * land in git), timings, sizes, request ids and dates (they change on every
 * recording and would make each re-record a noisy diff).
 */

interface Header {
  name: string;
  value: string;
}
interface HarContent {
  mimeType?: string;
  text?: string;
  encoding?: string;
  size?: number;
}
export interface HarEntry {
  startedDateTime?: string;
  request: {
    method: string;
    url: string;
    httpVersion?: string;
    headers: Header[];
    postData?: { mimeType?: string; text?: string };
    [k: string]: unknown;
  };
  response: {
    status: number;
    statusText?: string;
    httpVersion?: string;
    headers: Header[];
    content: HarContent;
    redirectURL?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface Har {
  log: { version: string; creator: { name: string; version: string }; entries: HarEntry[]; [k: string]: unknown };
}

/** Request headers worth keeping: they only break ties between duplicate entries. */
const KEEP_REQUEST = new Set(['accept', 'content-type']);
/** Response headers the browser needs to read the body (and follow a redirect). */
const KEEP_RESPONSE = new Set(['content-type', 'location']);

const keep = (headers: Header[], allowed: Set<string>) =>
  headers.filter((h) => allowed.has(h.name.toLowerCase())).map((h) => ({ name: h.name.toLowerCase(), value: h.value }));

export function cleanEntry(entry: HarEntry, recordedAt: string): HarEntry {
  const { request, response } = entry;
  return {
    startedDateTime: recordedAt,
    time: 0,
    request: {
      method: request.method,
      url: request.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: keep(request.headers, KEEP_REQUEST),
      queryString: [],
      ...(request.postData ? { postData: { mimeType: request.postData.mimeType, text: request.postData.text } } : {}),
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: response.status,
      statusText: response.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: keep(response.headers, KEEP_RESPONSE),
      content: {
        mimeType: response.content.mimeType ?? 'application/octet-stream',
        size: -1,
        ...(response.content.text !== undefined ? { text: response.content.text } : {}),
        ...(response.content.encoding ? { encoding: response.content.encoding } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

const entryKey = (e: HarEntry) =>
  JSON.stringify([e.request.method, e.request.url, e.request.postData?.text ?? null, e.response.status, e.response.content.text ?? null]);

/**
 * One HAR from several recordings of the same page (desktop, then phone).
 * Identical exchanges are kept once; a request answered differently the
 * second time keeps both, and the replay takes the first.
 */
export function mergeHars(files: string[], recordedAt: string, drop: (url: URL) => boolean = () => false): Har {
  const seen = new Set<string>();
  const entries: HarEntry[] = [];
  for (const file of files) {
    const har = JSON.parse(fs.readFileSync(file, 'utf8')) as Har;
    for (const raw of har.log.entries) {
      if (drop(new URL(raw.request.url))) continue;
      const entry = cleanEntry(raw, recordedAt);
      const key = entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return { log: { version: '1.2', creator: { name: 'alto-visual-record', version: '1' }, entries } };
}

/** Never let a credential reach a committed recording. */
export function assertNoSecrets(har: Har, file: string) {
  for (const e of har.log.entries) {
    for (const h of [...e.request.headers, ...e.response.headers]) {
      if (/^(cookie|set-cookie|authorization)$/i.test(h.name)) throw new Error(`${file}: ${h.name} header survived clean-up`);
    }
  }
}
