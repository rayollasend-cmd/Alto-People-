# Alto People → ASN Integration Guide

Read-only HTTP API for the AltoHR / ShiftReport Nexus (ASN) site to surface
Alto People's schedule and live clock-in data inside ops tooling. Designed
for both supervisor-scoped and global (Command Desk / Operations Manager)
consumers.

## Base URL

```
Production:  https://<your-alto-people-host>/api/integrations/v1
```

The `/api` prefix is required when calling the production deployment (Express
strips it before routing). In local dev when you hit the API directly on
port 3001, drop the `/api`: `http://localhost:3001/integrations/v1`.

## Authentication

Every request requires a Bearer token in the `Authorization` header:

```
Authorization: Bearer altop_<64-hex-chars>
```

Keys are minted by an Alto People HR Administrator from **Settings →
Integrations**. The plaintext is shown **once** at create time — store it
in your secret manager immediately. After that, only the last 4 characters
are visible in the admin UI.

### Key scope

| `clientId` on key | What it sees                          | Typical ASN role            |
| ----------------- | ------------------------------------- | --------------------------- |
| `null` (global)   | Every store. Can list `/stores`.      | Command Desk, Ops Manager   |
| `<store-uuid>`    | Only that one store. `/stores` → 403. | Supervisor, Lead Supervisor |

A request to a store the key doesn't own returns **404** (deliberate — a
store-scoped key can't enumerate which storeIds exist).

### Capabilities

Each key carries a list of capabilities; each endpoint requires one. Issue
keys with the narrowest set the consumer actually needs.

| Endpoint                                | Capability            |
| --------------------------------------- | --------------------- |
| `GET /me`                               | _(none — auth only)_  |
| `GET /stores`                           | _(global key)_        |
| `GET /stores/:id/schedule`              | `asn:read:schedule`   |
| `GET /stores/:id/shifts/:id/roster`     | `asn:read:roster`     |
| `GET /stores/:id/clocked-in`            | `asn:read:clocked-in` |
| `GET /stores/:id/kpis`                  | `asn:read:kpis`       |

## Endpoints

### `GET /me`

Returns the scope and capabilities the bearer maps to. Use as a sanity
check before any user-facing render.

```json
{
  "name": "ASN Supervisor — Walmart 1234",
  "capabilities": ["asn:read:schedule", "asn:read:roster", "asn:read:clocked-in", "asn:read:kpis"],
  "scope": {
    "kind": "store",
    "store": { "id": "9b2…", "name": "Walmart Supercenter #1234", "state": "TX" }
  }
}
```

For a global key, `scope` is `{ "kind": "global" }`.

### `GET /stores` _(global keys only)_

Lists every active store on the platform.

```json
{
  "stores": [
    { "id": "9b2…", "name": "Walmart Supercenter #1234", "state": "TX",
      "latitude": 32.7767, "longitude": -96.7970 },
    { "id": "f04…", "name": "Walmart Neighborhood #5678", "state": "TX",
      "latitude": null, "longitude": null }
  ]
}
```

`latitude` / `longitude` are `null` when no geofence is configured.

### `GET /stores/:storeId/schedule?from&to&status`

Returns shifts for the store within the given window. Defaults to the
**current Monday → next Monday** if `from`/`to` are omitted. `status` is
optional — when omitted, every shift except `CANCELLED` is returned.

Query params:
- `from` — ISO timestamp, lower bound on `startsAt` (inclusive)
- `to` — ISO timestamp, upper bound on `startsAt` (exclusive)
- `status` — one of `DRAFT | OPEN | ASSIGNED | COMPLETED | CANCELLED`

Response:

```json
{
  "storeId": "9b2…",
  "from": "2026-04-27T00:00:00.000Z",
  "to": "2026-05-04T00:00:00.000Z",
  "count": 42,
  "shifts": [
    {
      "id": "shift-uuid",
      "position": "Cashier",
      "location": "Front lanes",
      "startsAt": "2026-04-28T13:00:00.000Z",
      "endsAt": "2026-04-28T21:00:00.000Z",
      "status": "ASSIGNED",
      "publishedAt": "2026-04-20T15:00:00.000Z",
      "assignee": {
        "id": "associate-uuid",
        "firstName": "Jane",
        "lastName": "Doe"
      }
    }
  ]
}
```

`assignee` is `null` for `OPEN` / unfilled shifts. Page size cap: 500
shifts. If you hit it, narrow the window.

### `GET /stores/:storeId/shifts/:shiftId/roster`

Single shift detail with live clock-in status for the assignee. This is
the answer to "is the person scheduled for this shift currently on the
clock?"

```json
{
  "storeId": "9b2…",
  "shift": {
    "id": "shift-uuid",
    "position": "Cashier",
    "location": "Front lanes",
    "startsAt": "2026-04-28T13:00:00.000Z",
    "endsAt": "2026-04-28T21:00:00.000Z",
    "status": "ASSIGNED",
    "assignee": {
      "id": "associate-uuid",
      "firstName": "Jane",
      "lastName": "Doe",
      "live": { "state": "CLOCKED_IN", "clockInAt": "2026-04-28T12:58:14.220Z" }
    }
  }
}
```

`live` shapes:
- `{ "state": "CLOCKED_IN", "clockInAt": "<iso>" }`
- `{ "state": "CLOCKED_OUT" }`
- `null` — only when `assignee` is null (unassigned shift)

Returns 404 if the shift doesn't exist **or** belongs to a different store.

### `GET /stores/:storeId/clocked-in`

Live roster — every associate with an open `TimeEntry` at this store right
now. Indexed query; safe to poll every few seconds.

```json
{
  "storeId": "9b2…",
  "asOf": "2026-04-28T18:42:11.001Z",
  "count": 17,
  "clockedIn": [
    {
      "timeEntryId": "te-uuid",
      "clockInAt": "2026-04-28T12:58:14.220Z",
      "associate": { "id": "associate-uuid", "firstName": "Jane", "lastName": "Doe" }
    }
  ]
}
```

### `GET /stores/:storeId/kpis?days=7`

Week-summary signal strip. `days` is 1–30 (default 7). Window starts at
the most recent Monday 00:00 local.

```json
{
  "storeId": "9b2…",
  "window": {
    "from": "2026-04-27T00:00:00.000Z",
    "to": "2026-05-04T00:00:00.000Z",
    "days": 7
  },
  "kpis": {
    "scheduledShifts": 78,
    "assignedShifts": 65,
    "openShifts": 8,
    "cancelledShifts": 5,
    "clockedInRightNow": 17,
    "distinctAssociatesScheduled": 42
  }
}
```

## Errors

All errors are JSON with this shape:

```json
{ "error": { "code": "...", "message": "..." } }
```

| HTTP | `code`            | When                                                                  |
| ---- | ----------------- | --------------------------------------------------------------------- |
| 400  | `invalid_body`    | Malformed query params (bad ISO date, out-of-range `days`, etc.)      |
| 401  | `unauthenticated` | Missing/malformed bearer, unknown key, revoked, or expired            |
| 403  | `forbidden`       | Authenticated, but the key is missing the capability for this route   |
| 404  | `not_found`       | Store or shift doesn't exist, or the key isn't scoped to that store   |
| 429  | `rate_limited`    | Per-key rate limit exceeded (60 req/min/key)                          |
| 500  | `internal`        | Unexpected server error — file a ticket with the request id           |

`401` deliberately collapses _no key / wrong key / revoked / expired_ into
the same response so a probing client can't distinguish them.

## Rate limits

- **60 requests / minute / key**, sliding window.
- Standard `RateLimit-*` headers are returned (`draft-7`).
- 429 responses include a generic message; back off for ~60s before
  retrying.

For high-frequency dashboards, prefer **one polling worker per ASN
deployment that fans data out internally** rather than letting every UI
session hit Alto People directly.

## CORS

The integration API runs on the same origin as the rest of Alto People.
If you call it from a browser context, the ASN domain has to be in
Alto People's `CORS_ORIGIN` env var (comma-separated). Server-to-server
callers don't need anything CORS-related.

## Operational notes

- **Audit trail**: requests via API key are logged with the key's id (not
  a human user). HR admins reviewing audit logs will see "api-key:
  ASN Supervisor — Walmart 1234" rather than a person's email.
- **Key rotation**: revoke + re-issue. There is no in-place rotation —
  the plaintext is only revealed once at creation.
- **Polling cadence**: 30s is a sensible default for "clocked-in" and
  "kpis." Schedule data changes hourly at most; once every 5 minutes is
  more than enough.

## Quick start (Node.js)

```ts
const ALTO_KEY = process.env.ALTO_PEOPLE_API_KEY!;
const ALTO_BASE = process.env.ALTO_PEOPLE_BASE!; // e.g. "https://app.alto-people.com/api/integrations/v1"

async function altoGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ALTO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ALTO_KEY}` },
  });
  if (!res.ok) throw new Error(`Alto API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// On a Supervisor's store dashboard:
const me = await altoGet<{ scope: { kind: string; store?: { id: string } } }>('/me');
const storeId = me.scope.kind === 'store' ? me.scope.store!.id : null;
if (!storeId) throw new Error('Not a store-scoped key');

const [schedule, clockedIn, kpis] = await Promise.all([
  altoGet(`/stores/${storeId}/schedule`),
  altoGet(`/stores/${storeId}/clocked-in`),
  altoGet(`/stores/${storeId}/kpis?days=7`),
]);
```
