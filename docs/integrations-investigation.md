# Brief 3-5 — HR and VMS integrations

Built 2026-10-15 on the owner's instruction to complete Phase 3 without stopping. One adapter interface, five vendors, a per-tenant field mapping, scheduled and event-driven sync, and a sync log the tenant admin reads. Every adapter proves itself in sandbox mode in CI; the live paths wait on a vendor credential.

## The interface

`apps/api/src/lib/integrations/adapter.ts` — `IntegrationAdapter` with seven optional capabilities: `pullWorkers`, `pushWorkers`, `pullSchedules`, `pushSchedules`, `pushTimesheets`, `pushPayrollExport`, `pullWorkOrders`. Each takes an `AdapterContext` (the connection, decrypted credentials, the merged mapping, `fetch`, the clock) and returns one `SyncOutcome` per record (`ok`, `message`, an `excerpt` the runner redacts) plus a summary. Alto's records are loaded once per run by `domain.ts` into vendor-neutral shapes; an adapter never queries Prisma.

| Piece | Where |
|---|---|
| Models | `IntegrationConnection` (tenant, vendor, status, `sandbox`, `credentialsEnc` under the keyring, `mapping`, `capabilities`, `scheduleMinutes`, `eventDriven`, clocks), `IntegrationSyncRun`, `IntegrationSyncError`; migration `20261207100000_integrations` |
| Runner | `lib/integrations/sync.ts` — `runSync` (one run per connection and capability), `runScheduledSyncs` (per tenant every five minutes from `index.ts`), `syncForEvent` + `installEventSync` (a listener on the webhook fan-out: `onWebhookEvent` in `webhookDispatch.ts`) |
| Catalog | `lib/integrations/registry.ts` — label, capabilities, credential fields, default mapping, API note per vendor |
| Routes | `routes/integrationConnections.ts` at `/integration-connections` (list, vendors, create, read, patch, delete, `/test`, `/sync`, `/runs`, `/runs/:runId/errors`); view needs `view:integrations`, change and run need `manage:integrations`; every change and run is audited |
| Web | Settings & Trust › Integrations › Connections (`pages/integrations/connections/`): the list, the connect drawer with credentials and the mapping editor, the sync log page with per-record errors |
| Shared | `packages/shared/src/integrations.ts` — vendors, capabilities, mapping type, zod schemas (PURE-wrapped) |

## Per adapter

| Vendor | Capabilities | Sandbox proves | Live needs from the vendor (confirm against vendor docs) |
|---|---|---|---|
| SAP Fieldglass | `pushTimesheets`, `pullWorkOrders` | A closed pay period's APPROVED time, one line per person per day with the client's Fieldglass Site label and bill rate, submitted with zero manual entries; the work-order download mapped to records, a row without an id rejected | Connector base URL, OAuth2 client id/secret, application key; the Time Sheet Upload connector's accepted batch shape and the Work Order Download endpoint on the customer's instance |
| ADP Workforce Now | `pushPayrollExport`, `pullWorkers`, `pushWorkers` | A finalized run exported as pay data rows and reconciled to the run's gross, net and count to the cent; Workers v2 rows mapped (a worker without a work email rejected) | API base and token URLs, client id/secret, mutual-TLS certificate uploaded in the ADP console, payroll group code, the earning codes the customer's pay data import expects |
| Workday | `pullWorkers`, `pushWorkers`, `pullSchedules`, `pushSchedules` | A RaaS workers report mapped (termination date carried), the Scheduling API's shifts mapped (an unassigned shift kept, a broken row rejected) | REST base URL, tenant, the RaaS report URL and its column names, OAuth2 API client with a refresh token |
| UKG Pro WFM | `pullWorkers`, `pushWorkers`, `pullSchedules`, `pushSchedules` | Persons multi_read rows mapped (a person without a work email rejected), schedule multi_read shifts mapped | API base URL, app key, client id/secret, an integration user and password; the org path convention |
| Beeline | `pullWorkOrders`, `pushTimesheets` | Active assignments mapped to work orders with the bill rate; timesheet lines submitted, a zero-hour line rejected | API base URL, API key, client credentials |

Live request shapes sit in each `vendors/<vendor>.ts` and are the published shapes as read on 2026-10-15, not a contract test: the first live run against each customer's instance is the acceptance, and the sync log is where it shows.

## Decisions taken

- **A pull stages, it does not write people.** Workers, schedules and work orders pulled from a vendor are matched to Alto's people by work email and kept in the run's summary (counts and a short preview). Creating or changing a person from a vendor row is a desk decision with an audit trail, built when a customer asks for it, never a timer's.
- **Work email is the matching key** until a link table carries each vendor's id per person; the ADP, Workday and UKG ids are kept on the staged rows so that table can be filled from the first pull.
- **Sandbox is the default** for a new connection and the only path CI runs; `Run sandbox test` on a live connection also replays fixtures, so a mapping change is proven before it touches the vendor.
- **Credentials** are one JSON object encrypted with the field-encryption keyring (`integrationConnection.credentialsEnc` is in `FIELD_COLUMNS`, so rotation and the boot canary cover it); the API never returns them, only `hasCredentials`.
- **Sync errors are redacted** before they are stored: emails keep their domain only, phone and SSN-shaped numbers and long identifiers are masked, and any field named like a secret is dropped.
- **Event-driven sync is debounced** to one run per connection and capability a minute (a burst of shift edits is one push); the timesheet push on `time_entry.approved` sends the current biweekly period, the scheduled push sends the last closed one.
- **Reconciliation** for the ADP export is in the run: sent gross, net and count against the run's own totals; a mismatch is a failed record on the run, not a silent export.

## Open questions for the owner

- Which customer system comes first after Fieldglass: ADP for Alto's own payroll, or Workday/UKG for the first enterprise tenant? The live paths need that customer's sandbox tenant.
- Fieldglass: confirm whether Alto submits through the Connector API or through the Timesheet Upload file on the customer's instance; the adapter speaks the API shape.
- The earning codes ADP expects per customer (regular, overtime, reimbursement) — the export carries hours, gross and the deductions and leaves the code mapping to the tenant's mapping editor.
