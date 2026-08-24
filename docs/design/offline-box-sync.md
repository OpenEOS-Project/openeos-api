# Offline Box Sync — Design Doc

**Status:** §7 build-order steps 1–2 implemented (schema + SyncModule scaffold, branch `feat/offline-box-sync-step1-schema`). Steps 3–5 (provisioning endpoint, syncStatus UI, bidirectional catalog sync) not started.
**Author:** proposed via community contribution
**Depends on:** the airgapped/self-hosted deployment work in `docker-compose.airgap.yml` (this repo, `openeos-web`, `openeos-shop`, `openeos-landing`, `openeos-docs`)

## Problem

OpenEOS is offered as rentable hardware kits ("boxes"): tablets/phones, printers, a WiFi router, and a small local server. A box needs to run a full event with **no connectivity to the central OpenEOS installation** — venues are frequently offline or unreliable — and afterward (or opportunistically during the event, if a link exists) sync everything that happened back to the central installation that manages all customers.

This doc proposes a data model and sync protocol for that, built on top of the `RentalHardware`/`RentalAssignment` module that already exists in this repo (`src/database/entities/rental-hardware.entity.ts`, `rental-assignment.entity.ts`, `src/modules/rentals/`).

## Terminology

- **Box** — one `RentalAssignment`, bundling a Local Server with the POS devices, printer-agents, and router shipped for one event.
- **Local Server** — a new `RentalHardwareType.LOCAL_SERVER`: a mini-PC/NUC in the box running the same `openeos-api` + `openeos-web` + Postgres + Redis stack as the airgap deployment, pre-seeded with that event's data.
- **Central** — the existing hosted installation. Source of truth for org/user/catalog data; aggregation point for what happened at every event.

## 1. Partitioning: why this avoids multi-master sync

Every transactional row that matters here (`Order`, `OrderItem`, `Payment`, `PrintJob`, inventory movements) is already scoped by `eventId`. If exactly one Local Server is ever active for a given event, that server is the sole writer for every row carrying that `eventId`, for the whole rental window — Central never writes those rows while the box is checked out.

That single invariant — **one event, one writer, for the duration of the assignment** — removes the need for CRDT-style conflict resolution. `RentalAssignment` already encodes "this hardware belongs to this org/event for these dates"; this design extends that to also mean "this box holds write authority for this event's data for these dates."

What still needs conflict handling despite that: reference data both sides could touch (a product's price edited centrally while the box also has it cached — see §5, explicitly deferred).

## 2. Data model changes

### 2.1 `RentalHardwareType` additions

```ts
export enum RentalHardwareType {
  PRINTER = 'printer',
  DISPLAY = 'display',
  LOCAL_SERVER = 'local_server', // new
  TABLET = 'tablet',             // new
  PHONE = 'phone',                // new
  ROUTER = 'router',              // new
}
```

Tablets/phones/router need no sync logic of their own — they're POS clients pointed at the Local Server's `openeos-web`, exactly like any other airgapped deployment. Only the `LOCAL_SERVER` entry participates in sync.

### 2.2 Sync provenance columns

Add to every event-scoped syncable entity (`Order`, `OrderItem`, `Payment`, `PrintJob`, and anything else keyed by `eventId`):

| Column | Type | Purpose |
|---|---|---|
| `origin_node` | `varchar` | `'central'` or the `rental_assignment.id` of the box that wrote this row |
| `sync_version` | `bigint` | Monotonic per-row counter, incremented on every local write. **Not** a timestamp — a box can run for days with a drifted or unset clock. |
| `synced_at` | `timestamptz null` | Last time this row was accepted by Central. `null` = pending push. |

### 2.3 Soft deletes on syncable entities

`SoftDeleteEntity` already exists in `base.entity.ts` but is opt-in. A hard `DELETE` on the box is unrepresentable to Central once synced — deletes must replay as tombstones (`deletedAt` set), not disappear rows silently. Every syncable entity should extend `SoftDeleteEntity`, not `BaseEntity`.

### 2.4 `RentalAssignment.syncStatus`

```ts
export enum RentalSyncStatus {
  NOT_PROVISIONED = 'not_provisioned',
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  ERROR = 'error',
}
```

So ops can see box state from the dashboard without SSHing into hardware.

### 2.5 Integrity constraint

Unique partial index to make "two boxes assigned to the same event" a DB-level impossibility rather than a process hope:

```sql
CREATE UNIQUE INDEX rental_assignments_one_active_per_event
  ON rental_assignments (event_id)
  WHERE status = 'active';
```

## 3. Provisioning (before the box leaves the warehouse)

New endpoint: `POST /rentals/:assignmentId/provision`.

1. Central bundles a snapshot for that `organizationId` + `eventId`: `Organization`, its `User`/`UserOrganization` rows (so staff can log in offline), `Product`/`Category`/`PfandType` catalog, `OrganizationSettings` (including TSE config), and the `Event` row itself.
2. Snapshot is loaded into the Local Server's Postgres directly during warehouse prep (wired connection or a temporary LAN link) — a one-time seed, not part of the ongoing sync protocol, so it can be a straightforward `pg_dump`/restore of the relevant rows rather than new streaming API surface.
3. `RentalAssignment.syncStatus`: `provisioning` → `active` once the box boots standalone and passes a self-check (api healthy, catalog row counts match the snapshot).

This reuses the airgap stack as-is — the Local Server just gets pre-seeded data instead of an empty database.

## 4. Offline operation (during the event)

No new code beyond what the airgap PRs already add. Printer-agents and POS devices self-register against the **Local Server's** api (not Central) via the existing `/devices/init` verification-code flow — already internet-free. Staff log in with accounts provisioned in §3.

**TSE/KassenSichV fiscal signing is unaffected.** `DeviceSettings.tseClientId` and the §19 UStG handling already in this schema are local hardware/software concerns, not cloud-dependent — compliance holds offline exactly as it does online.

**Known, out-of-scope limitation:** SumUp card readers need their own connectivity to authorize a transaction — a payment-network constraint no sync design changes. Fully offline events are cash-only unless the box's router has any uplink (a phone hotspot is enough for SumUp even if the office link is down). State this explicitly to event planners; don't let it be silently assumed away.

## 5. Sync protocol

**Outbox pattern**, running inside the Local Server's `openeos-api` as a new `SyncModule` — not a separate service.

- Every write to a syncable entity also inserts a row into a local `sync_outbox` table: entity type, entity id, `sync_version`, payload.
- A background loop pushes batches to `POST https://api.openeos.de/sync/push` whenever it can reach Central — no schedule assumption; retry-with-backoff, so it behaves the same whether that's mid-event on a phone hotspot or a bulk push after return.
- Central's `/sync/push` handler is **idempotent by `(entity_id, sync_version)`**: a retried batch after a dropped connection never double-applies. Central upserts tagging `origin_node = assignment.id`, so it can distinguish box-authored rows from rows a staff member edited centrally after the fact.
- **Direction is push-only for event-scoped transactional data.** Central never writes into an active event's rows, so there is nothing to merge in the common case.
  - Exception: catalog corrections pushed from Central mid-event (a price fixed while the box is still running). **Explicitly deferred** — document as a known gap rather than build bidirectional merge for a rare case (see §7, step 5).

`RentalAssignment.syncStatus` moves to `synced` once the outbox drains to zero and a checksum (row count + hash of ids for that event) confirms Central's view matches the box's.

## 6. Failure modes

| Failure | Mitigation |
|---|---|
| Box never reconnects (lost, stolen, hardware dies) | Data lives only on that box until physically retrieved. Add an optional periodic local backup export (`pg_dump` to USB) as a shutdown-checklist step — a process fix, not a protocol fix. |
| Two boxes assigned to the same event | DB constraint, §2.5 — turns a scheduling mistake into a rejected write instead of silent data loss. |
| Sync interrupted mid-batch | Idempotent upserts (§5) make retry a no-op, not a corruption risk. |
| Clock drift on an offline box | `sync_version` is a local monotonic Postgres sequence, never wall-clock time. |

## 7. Suggested build order

1. ✅ Schema: provenance columns + soft-delete on syncable entities, `RentalHardwareType` additions, unique-active-assignment constraint.
2. ✅ `SyncModule`: outbox table, push loop, idempotent Central ingest endpoint. No provisioning automation yet — seed one box by hand, prove push-only sync against one real event.

   Landed as designed, with one scope narrowing found during implementation: `POST /sync/push` writes into `sync_inbox` (a staging table), not directly into the live `orders`/`order_items`/`payments`/`print_jobs` tables. Materializing into those tables hits a real foreign-key gap — an `Order.createdByDeviceId` points at a `Device` row that self-registered against the box's *local* api and was never synced to Central, so a naive insert breaks on the first real order. Devices need their own sync path before materialization is safe. Tracked as an open question below, not papered over with an untested generic upsert.
3. Provisioning endpoint (§3), wired into the `RentalAssignment` lifecycle (`confirmed` → auto-provision before `pickupAt`).
4. `syncStatus` visibility in `openeos-web`'s rentals UI — so staff can see "this box hasn't synced back yet" without a terminal.
5. Bidirectional catalog corrections — only if step 2 in production shows it's actually needed, not built ahead of evidence.

## Open questions

- **New, found during step 2:** how do `sync_inbox` rows get materialized into the live tables? Needs Device rows to be resolvable centrally first — either Devices become syncable too (their own outbox/inbox flow, same pattern), or provisioning pre-creates placeholder Device rows centrally that the box's local devices map onto. Not designed yet.
- Backup/export format for the "box never reconnects" case — plain `pg_dump`, or something the rentals UI can trigger remotely while the box still has connectivity?
- Should `sync_outbox` payloads be full entity snapshots or diffs? Snapshots are simpler and idempotency-safe by construction; diffs are smaller but need care to stay replay-safe.
- Does provisioning need to be resumable (box prep interrupted partway), or is "start over" acceptable given it's a warehouse process, not a live one?
