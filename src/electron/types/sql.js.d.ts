/**
 * Minimal type declarations for sql.js — the package ships none.
 * Only the surface AppDb (store/db.ts) uses.
 */
declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface SqlJsConfig {
    /** Resolve a loader asset (the wasm file) to an absolute path. */
    locateFile?: (file: string, prefix: string) => string;
  }

  export class Statement {
    /** Bind parameters (array or object). Returns false on mismatch. */
    bind(params?: unknown): boolean;
    /** Run one step. True if a row is available. */
    step(): boolean;
    /** Current row as an array. */
    get(): unknown[];
    /** Current row as an object keyed by column name. */
    getAsObject(): Record<string, unknown>;
    /** Execute (write statements). */
    run(params?: unknown): void;
    reset(): void;
    free(): boolean;
  }

  export class Database {
    /** Create from raw SQLite file bytes (or an empty database). */
    constructor(data?: ArrayLike<number> | null);
    /** Execute a statement (may write). */
    run(sql: string, params?: unknown): Database;
    /** Execute and return result sets (read or write). */
    exec(sql: string, params?: unknown): QueryExecResult[];
    /** Prepare a statement for parameterized use. */
    prepare(sql: string, params?: unknown): Statement;
    /** Serialize the database back to SQLite file bytes. */
    export(): Uint8Array;
    /** The row count changed by the last write statement. */
    getRowsModified(): number;
    close(): void;
  }

  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
