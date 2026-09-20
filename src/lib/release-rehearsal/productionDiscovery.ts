export function productionMigrationDiscoveryPlan() {
  return Object.freeze({
    executable: false,
    authorizationRequired: 'SEPARATE_AUTHENTICATED_READ_ONLY_DISCOVERY',
    baseline: 'UNKNOWN_UNTIL_AUTHENTICATED_DISCOVERY',
    targetReferences: Object.freeze(['accountId', 'databaseId', 'workerName']),
    queries: Object.freeze([
      "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','index') ORDER BY name LIMIT 201",
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='d1_migrations' LIMIT 1",
      'SELECT id, name, applied_at FROM d1_migrations ORDER BY id LIMIT 51',
    ]),
    queryPrerequisites: Object.freeze(['VERIFY_EXACT_ACCOUNT_AND_DATABASE', 'VERIFY_LEDGER_COLUMNS_BEFORE_LEDGER_QUERY']),
    blockers: Object.freeze(['MISSING_LEDGER', 'TRUNCATED_RESULTS', 'UNKNOWN_MIGRATION', 'MISSING_CHECKSUM_PROVENANCE',
      'SCHEMA_DRIFT', 'BACKUP_UNVERIFIED', 'RECOVERY_UNVERIFIED']),
    checksumPolicy: 'NAMES_ARE_NOT_CHECKSUMS_REQUIRE_AUTHENTICATED_PRIOR_RELEASE_OR_SCHEMA_EXPORT_EVIDENCE',
    pendingSet: null,
    productionMigrations: 0,
  });
}
