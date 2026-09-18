import { createHash } from 'node:crypto';
import { RELEASE_LIMITS } from './contracts';
import type { MigrationClassification, ReleaseMigration } from './types';

export function classifyMigration(sql: string): MigrationClassification {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > 256 * 1024) return 'UNKNOWN';
  const code = sql.replace(/'(?:''|[^'])*'/g, "'literal'").replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
  if (/\/\*|\*\//.test(code) || /(?:^|;|\bBEGIN)\s*(?:DROP|TRUNCATE|DELETE|UPDATE|REPLACE)\b/i.test(code)
    || /\bALTER\s+TABLE\s+\w+\s+DROP\b/i.test(code)) return 'DESTRUCTIVE';
  if (/\bCREATE\s+TRIGGER\b|\bALTER\s+TABLE\s+\w+\s+RENAME\b|(?:^|;)\s*INSERT\b/i.test(code)) return 'REVIEW_REQUIRED';
  const statements = code.split(';').map(statement => statement.trim()).filter(Boolean);
  if (!statements.length || statements.length > RELEASE_LIMITS.migrationStatements) return 'UNKNOWN';
  return statements.every(statement => /^CREATE\s+(?:TABLE\s+\w+\s*\(|(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+\w+\s*\()|^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+\w+\s+/i.test(statement))
    ? 'ADDITIVE_SAFE' : 'UNKNOWN';
}
export function migrationInventory(files: { name: string; sql: string }[]): ReleaseMigration[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > RELEASE_LIMITS.migrations) throw new Error('RELEASE_MIGRATION_BOUND');
  let previous = 0;
  return files.map(file => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file.name) || Number(file.name.slice(0, 4)) !== previous + 1) throw new Error('RELEASE_MIGRATION_ORDER');
    previous++;
    const statements = file.sql.split('-- statement-breakpoint').filter(statement => statement.trim()).length;
    if (statements > RELEASE_LIMITS.migrationStatements) throw new Error('RELEASE_MIGRATION_STATEMENT_BOUND');
    return { name: file.name, sha256: createHash('sha256').update(file.sql).digest('hex'), classification: classifyMigration(file.sql), statements };
  });
}
