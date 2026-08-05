/**
 * Hand-authored OpenAPI 3.1 description of the public integration API
 * (`/integrations/v1` — the AltoHR / ShiftReport Nexus bridge).
 *
 * Served at `GET /integrations/v1/openapi.json` WITHOUT a bearer so a
 * partner can bootstrap a client before their key arrives; the anon
 * rate limiter still applies. Keep this file in lockstep with
 * routes/integrationsV1.ts — the test suite asserts every documented
 * path exists on the router (and vice versa), so drift fails CI.
 *
 * Deliberately hand-written rather than generated: the surface is six
 * endpoints and the value is in the prose (auth, scoping, 404-on-scope
 * semantics, caps) that a generator can't write.
 */

const ERROR_ENVELOPE = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable machine-readable code, snake_case.',
        },
        message: { type: 'string' },
        details: { description: 'Optional structured validation detail.' },
        requestId: {
          type: 'string',
          description:
            'Present on responses produced by the global error handler; quote it when reporting an issue.',
        },
      },
    },
  },
} as const;

const ASSOCIATE_REF = {
  type: 'object',
  required: ['id', 'firstName', 'lastName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
  },
} as const;

const STANDARD_ERRORS = {
  '401': {
    description: 'Missing, malformed, revoked, or expired bearer key.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '403': {
    description: 'The key lacks the capability this endpoint requires.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '429': {
    description:
      'Rate limited (60 requests/min per key; separate pre-auth IP limit). Standard draft-7 RateLimit headers are set.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
} as const;

export const integrationsOpenapi = {
  openapi: '3.1.0',
  info: {
    title: 'Alto People — Integration API',
    version: '1.0.0',
    description: [
      'Read-only partner API for schedule, roster, live clock-in, and KPI data.',
      '',
      '**Authentication** — `Authorization: Bearer altop_<64 hex>`. Keys are issued by an',
      'Alto People admin (Settings → Integrations), carry a set of capabilities, and are',
      'either **global** (all stores) or **store-scoped** (one store).',
      '',
      '**Store scoping** — store-scoped keys receive `404` (not `403`) for any other',
      "store's resources, so store ids cannot be enumerated. Global keys may call",
      '`GET /stores` to discover ids.',
      '',
      '**Writes** — intentionally unsupported. Mutations stay on the human-session API so',
      'audit logs always carry a real user identity.',
    ].join('\n'),
  },
  servers: [{ url: '/integrations/v1' }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Alto People API key, format `altop_<64 hex chars>`. Shown once at creation; stored hashed.',
      },
    },
    schemas: {
      Error: ERROR_ENVELOPE,
      Associate: ASSOCIATE_REF,
      Shift: {
        type: 'object',
        required: ['id', 'position', 'location', 'startsAt', 'endsAt', 'status', 'assignee'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          position: { type: 'string', nullable: true },
          location: {
            type: 'string',
            nullable: true,
            description: 'Optional sub-zone label within the store.',
          },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          status: {
            type: 'string',
            enum: ['DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED'],
          },
          publishedAt: { type: 'string', format: 'date-time', nullable: true },
          assignee: { ...ASSOCIATE_REF, nullable: true },
        },
      },
    },
  },
  paths: {
    '/me': {
      get: {
        operationId: 'getMe',
        summary: 'Key introspection',
        description:
          'Echoes the key name, capabilities, and scope. Requires only a valid bearer — use it to confirm what the key can see before rendering anything.',
        responses: {
          '200': {
            description: 'Key identity and scope.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'capabilities', 'scope'],
                  properties: {
                    name: { type: 'string' },
                    capabilities: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: [
                          'asn:read:schedule',
                          'asn:read:roster',
                          'asn:read:clocked-in',
                          'asn:read:kpis',
                        ],
                      },
                    },
                    scope: {
                      oneOf: [
                        {
                          type: 'object',
                          required: ['kind'],
                          properties: {
                            kind: { const: 'global' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['kind', 'store'],
                          properties: {
                            kind: { const: 'store' },
                            store: {
                              type: 'object',
                              nullable: true,
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                name: { type: 'string' },
                                state: { type: 'string', nullable: true },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
    '/stores': {
      get: {
        operationId: 'listStores',
        summary: 'List stores (global keys only)',
        description:
          'Every active store, for a store picker. Store-scoped keys receive 403. Capped at 1000 rows.',
        responses: {
          '200': {
            description: 'Active stores.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['stores'],
                  properties: {
                    stores: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'name', 'state', 'latitude', 'longitude'],
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          name: { type: 'string' },
                          state: { type: 'string', nullable: true },
                          latitude: { type: 'number', nullable: true },
                          longitude: { type: 'number', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
    '/stores/{storeId}/schedule': {
      get: {
        operationId: 'getStoreSchedule',
        summary: 'Shifts for a store in a window',
        description:
          'Requires `asn:read:schedule`. Defaults to the current Monday → next Monday when from/to are omitted. Excludes CANCELLED unless a status filter is passed. Capped at 500 shifts per response — narrow the window to page.',
        parameters: [
          {
            name: 'storeId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Shifts in the window, ordered by start time.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['storeId', 'from', 'to', 'count', 'shifts'],
                  properties: {
                    storeId: { type: 'string', format: 'uuid' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    count: { type: 'integer' },
                    shifts: {
                      type: 'array',
                      maxItems: 500,
                      items: { $ref: '#/components/schemas/Shift' },
                    },
                  },
                },
              },
            },
          },
          '404': {
            description:
              'Store not found — also returned when a store-scoped key requests a different store.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
    '/stores/{storeId}/shifts/{shiftId}/roster': {
      get: {
        operationId: 'getShiftRoster',
        summary: 'Single-shift roster with live clock state',
        description:
          "Requires `asn:read:roster`. The assignee's `live` field reports whether they currently hold an ACTIVE time entry at this store.",
        parameters: [
          {
            name: 'storeId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'shiftId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Shift detail with assignee live status.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['storeId', 'shift'],
                  properties: {
                    storeId: { type: 'string', format: 'uuid' },
                    shift: {
                      allOf: [
                        { $ref: '#/components/schemas/Shift' },
                        {
                          type: 'object',
                          properties: {
                            assignee: {
                              nullable: true,
                              allOf: [
                                { $ref: '#/components/schemas/Associate' },
                                {
                                  type: 'object',
                                  properties: {
                                    live: {
                                      nullable: true,
                                      oneOf: [
                                        {
                                          type: 'object',
                                          required: ['state', 'clockInAt'],
                                          properties: {
                                            state: { const: 'CLOCKED_IN' },
                                            clockInAt: {
                                              type: 'string',
                                              format: 'date-time',
                                            },
                                          },
                                        },
                                        {
                                          type: 'object',
                                          required: ['state'],
                                          properties: {
                                            state: { const: 'CLOCKED_OUT' },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Shift or store not found (including scope mismatches).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
    '/stores/{storeId}/clocked-in': {
      get: {
        operationId: 'getClockedIn',
        summary: 'Who is clocked in right now',
        description:
          'Requires `asn:read:clocked-in`. Point-in-time live roster; capped at 500 entries.',
        parameters: [
          {
            name: 'storeId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Associates with an ACTIVE time entry.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['storeId', 'count', 'asOf', 'clockedIn'],
                  properties: {
                    storeId: { type: 'string', format: 'uuid' },
                    count: { type: 'integer' },
                    asOf: { type: 'string', format: 'date-time' },
                    clockedIn: {
                      type: 'array',
                      maxItems: 500,
                      items: {
                        type: 'object',
                        required: ['timeEntryId', 'clockInAt', 'associate'],
                        properties: {
                          timeEntryId: { type: 'string', format: 'uuid' },
                          clockInAt: { type: 'string', format: 'date-time' },
                          associate: { $ref: '#/components/schemas/Associate' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Store not found (including scope mismatches).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
    '/stores/{storeId}/kpis': {
      get: {
        operationId: 'getStoreKpis',
        summary: 'Week-summary KPI counts',
        description:
          'Requires `asn:read:kpis`. Window starts the current Monday and spans `days` days (1–30, default 7).',
        parameters: [
          {
            name: 'storeId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'days',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
          },
        ],
        responses: {
          '200': {
            description: 'Aggregate counts for the window.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['storeId', 'window', 'kpis'],
                  properties: {
                    storeId: { type: 'string', format: 'uuid' },
                    window: {
                      type: 'object',
                      required: ['from', 'to', 'days'],
                      properties: {
                        from: { type: 'string', format: 'date-time' },
                        to: { type: 'string', format: 'date-time' },
                        days: { type: 'integer' },
                      },
                    },
                    kpis: {
                      type: 'object',
                      required: [
                        'scheduledShifts',
                        'assignedShifts',
                        'openShifts',
                        'cancelledShifts',
                        'clockedInRightNow',
                        'distinctAssociatesScheduled',
                      ],
                      properties: {
                        scheduledShifts: { type: 'integer' },
                        assignedShifts: { type: 'integer' },
                        openShifts: { type: 'integer' },
                        cancelledShifts: { type: 'integer' },
                        clockedInRightNow: { type: 'integer' },
                        distinctAssociatesScheduled: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Store not found (including scope mismatches).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          ...STANDARD_ERRORS,
        },
      },
    },
  },
} as const;
