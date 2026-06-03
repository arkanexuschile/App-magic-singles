# Scheduler Execution Model

## Goal
Avoid overlap between three execution types per shop:
- Scheduled sync (`scheduled`)
- Manual sync (`manual`)
- Test sync (`test`)

## Concurrency Rule
Only one run can execute at a time **per shop**.

The scheduler enforces this with:
- In-memory lock (`__priceSyncActiveRunKindByShop`)
- DB lock via `lastRunStatus = running` + stale lock filter

If a run is active, any new run request for that shop is rejected and logged with:
- `runKind`: requested run kind
- `activeKind`: currently running kind

## Status Tracking
Manual and test runs keep separate status maps:
- `__priceSyncManualStatusByShop`
- `__priceSyncTestStatusByShop`

Statuses:
- `queued`
- `running`
- `success`
- `failed`

Terminal statuses are auto-cleaned after `MANUAL_STATUS_RETENTION_MS`.

## Main Flows
1. `enqueueManualSyncForShop()`
- Validates lock availability
- Stores `queued` status
- Starts background run

2. `runManualSyncForShop()`
- Acquires in-memory lock for `manual` or `test`
- Sets status `running`
- Executes sync
- Sets `success` / `failed`
- Releases lock in `finally`

3. `runSchedulerTickOnce()`
- Finds due shops
- Executes `runScheduledSyncForShop()` sequentially
- Uses same in-memory lock strategy per shop

## Log Conventions
All run logs include:
- `shop`
- `runKind` (where applicable)

This keeps logs readable when multiple triggers happen close together.
