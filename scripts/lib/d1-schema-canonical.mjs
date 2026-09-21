import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const METHOD_VERSION = 'd1-schema-canonical-v1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export const quoteIdentifier = name => `"${name.replaceAll('"', '""')}"`;

export function canonicalJson(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort(compareText).map(key => [key, ordered(item[key])]));
    }
    assert.ok(item === null || ['string', 'boolean'].includes(typeof item) || (typeof item === 'number' && Number.isFinite(item)), 'NON_JSON_CANONICAL_VALUE');
    return item;
  }
  return `${JSON.stringify(ordered(value))}\n`;
}

export function sqlTokens(sql) {
  const tokens = [];
  let offset = 0;
  while (offset < sql.length) {
    const remaining = sql.slice(offset);
    const whitespace = /^[\t\n\v\f\r ]+/.exec(remaining);
    if (whitespace) { offset += whitespace[0].length; continue; }
    if (remaining.startsWith('--')) {
      const newline = remaining.search(/[\r\n]/);
      offset += newline < 0 ? remaining.length : newline;
      continue;
    }
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      assert.ok(end >= 0, 'UNTERMINATED_SQL_COMMENT');
      offset += end + 2;
      continue;
    }
    if (['\'', '"', '`', '['].includes(sql[offset])) {
      const start = offset;
      const opening = sql[offset++];
      const closing = opening === '[' ? ']' : opening;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== closing) continue;
        if (opening !== '[' && sql[offset] === closing) { offset++; continue; }
        closed = true;
        break;
      }
      assert.ok(closed, 'UNTERMINATED_SQL_QUOTE');
      tokens.push(sql.slice(start, offset));
      continue;
    }
    const token = /^(?:[xX]'(?:[0-9a-fA-F]{2})*'|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-\uffff][A-Za-z_0-9$\u0080-\uffff]*|->>|->|\|\||<<|>>|<=|>=|<>|!=|==|[(),.;+*/%~&|=<>?:@$-])/.exec(remaining);
    assert.ok(token, `UNSUPPORTED_SQL_TOKEN_AT_${offset}`);
    tokens.push(token[0]);
    offset += token[0].length;
  }
  return tokens;
}

export const normalizeSql = sql => sql === null ? null : sqlTokens(sql).join(' ');

export function checkConstraints(sql) {
  const tokens = sqlTokens(sql);
  const checks = [];
  for (let position = 0; position < tokens.length; position++) {
    if (tokens[position].toUpperCase() !== 'CHECK' || tokens[position + 1] !== '(') continue;
    const expression = [];
    let depth = 1;
    position += 2;
    for (; position < tokens.length && depth > 0; position++) {
      const token = tokens[position];
      if (token === '(') depth++;
      if (token === ')') depth--;
      if (depth > 0) expression.push(token);
    }
    assert.equal(depth, 0, 'UNBALANCED_CHECK_EXPRESSION');
    checks.push(expression.join(' '));
    position--;
  }
  return checks;
}

export const includedObject = row => !row.name.startsWith('sqlite_')
  && !['_cf_KV', '_cf_METADATA', 'd1_migrations'].includes(row.name)
  && !['_cf_KV', '_cf_METADATA', 'd1_migrations'].includes(row.tbl_name);

export async function rows(database, sql, values = []) {
  const statement = database.prepare(sql);
  const result = await (values.length ? statement.bind(...values) : statement).all().catch(error => {
    throw new Error(`D1_QUERY_FAILED: ${sql}`, { cause: error });
  });
  assert.equal(result.success, true, 'D1_QUERY_FAILED');
  return result.results;
}

export async function batchRows(database, statements, chunkSize = 64) {
  const results = [];
  for (let offset = 0; offset < statements.length; offset += chunkSize) {
    const batch = await database.batch(statements.slice(offset, offset + chunkSize).map(sql => database.prepare(sql)));
    for (const result of batch) { assert.equal(result.success, true, 'D1_BATCH_QUERY_FAILED'); results.push(result.results); }
  }
  assert.equal(results.length, statements.length);
  return results;
}

export async function captureSchema(database) {
  const raw = await rows(database, 'SELECT type,name,tbl_name,sql FROM sqlite_schema');
  const objects = raw.filter(includedObject).sort((left, right) => compareText(left.type, right.type) || compareText(left.name, right.name));
  assert.ok(objects.every(row => ['table', 'index', 'trigger', 'view'].includes(row.type)), 'UNKNOWN_SCHEMA_OBJECT');
  const tableObjects = objects.filter(row => row.type === 'table');
  const metadata = await batchRows(database, tableObjects.flatMap(table => [
    `PRAGMA table_xinfo(${quoteIdentifier(table.name)})`, `PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`,
    `PRAGMA index_list(${quoteIdentifier(table.name)})`,
  ]));
  const indexNames = metadata.flatMap((list, position) => position % 3 === 2 ? list.map(index => index.name) : []);
  const indexMetadata = await batchRows(database, indexNames.map(name => `PRAGMA index_xinfo(${quoteIdentifier(name)})`));
  const indexColumns = new Map(indexNames.map((name, position) => [name, indexMetadata[position]]));
  const tables = [];
  for (const [position, table] of tableObjects.entries()) {
    const columns = metadata[position * 3]
      .map(row => ({ cid: row.cid, name: row.name, type: normalizeSql(row.type), notNull: row.notnull,
        default: normalizeSql(row.dflt_value), primaryKeyOrdinal: row.pk, hidden: row.hidden })).sort((left, right) => left.cid - right.cid);
    const foreignRows = metadata[position * 3 + 1];
    const groups = new Map();
    for (const foreign of foreignRows) {
      if (!groups.has(foreign.id)) groups.set(foreign.id, { table: foreign.table, onUpdate: foreign.on_update,
        onDelete: foreign.on_delete, match: foreign.match, columns: [] });
      groups.get(foreign.id).columns.push({ ordinal: foreign.seq, from: foreign.from, to: foreign.to });
    }
    const foreignKeys = [...groups.values()].map(group => ({ ...group, columns: group.columns.sort((left, right) => left.ordinal - right.ordinal) }))
      .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    const indexes = [];
    for (const index of metadata[position * 3 + 2]) {
      const definition = raw.find(row => row.type === 'index' && row.name === index.name);
      assert.ok(definition || index.origin !== 'c', 'INDEX_DEFINITION_MISSING');
      indexes.push({ name: index.name, unique: index.unique, origin: index.origin, partial: index.partial,
        sql: normalizeSql(definition?.sql ?? null), columns: indexColumns.get(index.name)
          .map(row => ({ ordinal: row.seqno, cid: row.cid, name: row.name, descending: row.desc, collation: row.coll, key: row.key }))
          .sort((left, right) => left.ordinal - right.ordinal) });
    }
    tables.push({ name: table.name, sql: normalizeSql(table.sql), columns,
      primaryKey: columns.filter(column => column.primaryKeyOrdinal > 0).sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal)
        .map(column => ({ ordinal: column.primaryKeyOrdinal, name: column.name })),
      checks: checkConstraints(table.sql), foreignKeys, indexes: indexes.sort((left, right) => compareText(left.name, right.name)) });
  }
  const schema = { methodVersion: METHOD_VERSION, tables,
    triggers: objects.filter(row => row.type === 'trigger').map(row => ({ name: row.name, table: row.tbl_name, sql: normalizeSql(row.sql) })),
    views: objects.filter(row => row.type === 'view').map(row => ({ name: row.name, sql: normalizeSql(row.sql) })) };
  const bytes = Buffer.from(canonicalJson(schema), 'utf8');
  const allIndexes = tables.flatMap(table => table.indexes);
  const migrationLedgerTables = raw.filter(row => row.type === 'table' && row.name === 'd1_migrations').length;
  return { schema, sha256: sha256(bytes), bytes: bytes.length, counts: { tables: tables.length,
    migrationLedgerTables, tablesIncludingMigrationLedger: tables.length + migrationLedgerTables,
    indexes: allIndexes.filter(index => index.origin === 'c').length,
    implicitIndexes: allIndexes.filter(index => index.origin !== 'c').length, allIndexes: allIndexes.length,
    triggers: schema.triggers.length, views: schema.views.length, checkConstraints: tables.reduce((sum, table) => sum + table.checks.length, 0) } };
}
