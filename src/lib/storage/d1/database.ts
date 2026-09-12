/** The binding methods used here; no Cloudflare globals or SDK in application imports. */
export type SqlValue = string | number | null;
export interface D1Rows<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: { rows_read?: number; rows_written?: number; changes?: number };
}
export interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1Rows<T>>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Rows<T>[]>;
}
