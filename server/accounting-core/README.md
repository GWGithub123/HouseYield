# Azure Accounting Core

This directory contains the first Phase 2 artifacts for the unified accounting backend.

## Goals

- Move the canonical ledger from Firestore into Azure SQL.
- Normalize every live finance input into a finance-event layer.
- Persist source events, idempotency keys, journal entries, journal lines, subledgers, reconciliation records, close periods, audit records, rulesets, and workpaper snapshots in one relational system.

## Current Files

- `sql/001_accounting_core_schema.sql`: initial Azure SQL schema.
- `azureSqlClient.js`: environment-aware Azure SQL connection skeleton.
- `checkHealth.js`: CLI health probe for Azure SQL configuration and connectivity.
- `postingEngine.js`: normalized finance-event and journal-draft builder.
- `ledgerStore.js`: idempotent Azure posting store for source events, finance events, journal entries, lines, subledgers, and audit rows.
- `runMigrations.js`: migration runner for the SQL files in `sql/`.
- `stripeFinanceEvents.js`: Stripe balance-transaction and Financial Connections normalization helpers for canonical ledger posting.
- `evidenceStore.js`: canonical finance evidence storage and entity-link helpers for receipts and future bookkeeping/tax document support.
- `taxRulesetStore.js`: Azure sync helper for versioned shared tax ruleset packages.
- `workpaperSnapshotBuilder.js`: assembles versioned Schedule E, depreciation, 1099 readiness, and checklist snapshots from one workpaper source.
- `workpaperSnapshotStore.js`: persists explicit workpaper snapshot records into Azure SQL.

## Expected Environment Variables

- `AZURE_SQL_SERVER`
- `AZURE_SQL_DATABASE`
- `AZURE_SQL_USER`
- `AZURE_SQL_PASSWORD`
- `AZURE_SQL_PORT` (optional, defaults to `1433`)

## Current Status

These files now support live canonical posting into Azure SQL for the Stripe and Firestore bookkeeping write paths, while preserving Firestore compatibility for the current UI and workflow surfaces. The production-facing bookkeeping API still routes through `server/bookkeeping-firestore.js`, but its canonical mirror is no longer limited to shadow-only posting.

## Commands

- `npm run accounting-core:health`
- `npm run accounting-core:migrate`
- `npm run accounting-core:sync-tax-ruleset`