/**
 * bun:sqlite shim
 *
 * Backed by AlaSQL (pure JS) so it works in browser and worker contexts.
 * This preserves Bun's synchronous API style for common SQLite workflows.
 */

import alasqlImport from 'alasql';

interface AlaSqlDatabase {
  exec(sql: string, params?: unknown[]): unknown;
}

interface AlaSqlModule {
  Database: new (name: string) => AlaSqlDatabase;
}

interface JournalEntry {
  sql: string;
  params: unknown[];
}

export interface DatabaseOptions {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
  strict?: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | null;
}

const alasqlModule = ((alasqlImport as unknown as { default?: unknown }).default ?? alasqlImport) as unknown as AlaSqlModule;

const persistedJournals = new Map<string, JournalEntry[]>();

let databaseCounter = 0;

function isMutatingStatement(sql: string): boolean {
  return /^\s*(insert|update|delete|replace|create|alter|drop|truncate|begin|commit|rollback|pragma|vacuum|attach|detach)\b/i.test(sql);
}

function normalizeExecParams(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0] as unknown[];
  }
  return params;
}

function encodeParam(param: unknown): unknown {
  if (param instanceof Uint8Array) {
    return {
      __type: 'uint8array',
      data: Array.from(param),
    };
  }

  if (param instanceof ArrayBuffer) {
    return {
      __type: 'arraybuffer',
      data: Array.from(new Uint8Array(param)),
    };
  }

  if (ArrayBuffer.isView(param)) {
    const view = param as ArrayBufferView;
    return {
      __type: 'arraybufferview',
      data: Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }

  return param;
}

function decodeParam(param: unknown): unknown {
  if (!param || typeof param !== 'object') {
    return param;
  }

  const tagged = param as { __type?: string; data?: number[] };
  if (!tagged.__type || !Array.isArray(tagged.data)) {
    return param;
  }

  if (tagged.__type === 'uint8array' || tagged.__type === 'arraybufferview') {
    return new Uint8Array(tagged.data);
  }

  if (tagged.__type === 'arraybuffer') {
    return new Uint8Array(tagged.data).buffer;
  }

  return param;
}

function cloneEntry(entry: JournalEntry): JournalEntry {
  return {
    sql: entry.sql,
    params: entry.params.map(encodeParam),
  };
}

function replayEntry(db: AlaSqlDatabase, entry: JournalEntry): void {
  db.exec(entry.sql, entry.params.map(decodeParam));
}

function inferChanges(result: unknown): number {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return result;
  }

  if (Array.isArray(result)) {
    return result.length;
  }

  return 0;
}

function inferLastInsertRowid(result: unknown): number | null {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  const first = result[0];
  if (!first || typeof first !== 'object') {
    return null;
  }

  const record = first as Record<string, unknown>;
  for (const key of ['id', 'rowid', 'lastInsertRowid']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function normalizeRows(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) {
    return [];
  }

  return result.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }

    return { value: row };
  });
}

export class Statement<TRow = Record<string, unknown>> {
  private mapper: ((row: Record<string, unknown>) => TRow) | null;

  constructor(
    private readonly database: Database,
    public readonly source: string,
    mapper?: (row: Record<string, unknown>) => TRow
  ) {
    this.mapper = mapper ?? null;
  }

  all(...params: unknown[]): TRow[] {
    const result = this.database._execute(this.source, normalizeExecParams(params));
    const rows = normalizeRows(result);

    if (this.mapper) {
      return rows.map(this.mapper);
    }

    return rows as unknown as TRow[];
  }

  get(...params: unknown[]): TRow | null {
    const rows = this.all(...params);
    return rows.length > 0 ? rows[0] : null;
  }

  values(...params: unknown[]): unknown[][] {
    const rows = this.all(...params) as unknown[];

    return rows.map((row) => {
      if (Array.isArray(row)) {
        return row;
      }

      if (row && typeof row === 'object') {
        return Object.values(row as Record<string, unknown>);
      }

      return [row];
    });
  }

  run(...params: unknown[]): RunResult {
    return this.database._run(this.source, normalizeExecParams(params));
  }

  *iterate(...params: unknown[]): IterableIterator<TRow> {
    for (const row of this.all(...params)) {
      yield row;
    }
  }

  as<TMapped extends object>(ctor: new () => TMapped): Statement<TMapped> {
    return new Statement<TMapped>(this.database, this.source, (row) => Object.assign(new ctor(), row));
  }

  finalize(): void {
    // AlaSQL does not need explicit statement finalization.
  }
}

export class Database {
  private db: AlaSqlDatabase;
  private readonly journal: JournalEntry[] = [];
  private closed = false;

  readonly filename: string;
  readonly options: DatabaseOptions;

  constructor(filename: string = ':memory:', options: DatabaseOptions = {}) {
    this.filename = filename;
    this.options = {
      create: options.create ?? true,
      readonly: options.readonly ?? false,
      readwrite: options.readwrite ?? true,
      strict: options.strict ?? false,
    };

    databaseCounter += 1;
    this.db = new alasqlModule.Database(`bun_sqlite_${databaseCounter}`);

    const persisted = this.filename === ':memory:' ? null : persistedJournals.get(this.filename);
    if (persisted && persisted.length > 0) {
      for (const entry of persisted) {
        replayEntry(this.db, entry);
        this.journal.push(cloneEntry(entry));
      }
    } else if (this.filename !== ':memory:' && this.options.create === false) {
      throw new Error(`bun:sqlite: database file not found: ${this.filename}`);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('bun:sqlite: database is closed');
    }
  }

  private persistJournal(): void {
    if (this.filename === ':memory:') {
      return;
    }

    persistedJournals.set(this.filename, this.journal.map(cloneEntry));
  }

  private rebuildFromJournal(): void {
    databaseCounter += 1;
    this.db = new alasqlModule.Database(`bun_sqlite_${databaseCounter}`);
    for (const entry of this.journal) {
      replayEntry(this.db, entry);
    }
    this.persistJournal();
  }

  private rollbackToJournalLength(journalLength: number): void {
    if (journalLength >= this.journal.length) {
      return;
    }

    this.journal.splice(journalLength);
    this.rebuildFromJournal();
  }

  private recordMutation(sql: string, params: unknown[]): void {
    this.journal.push({
      sql,
      params: params.map(encodeParam),
    });

    this.persistJournal();
  }

  _execute(sql: string, params: unknown[] = []): unknown {
    this.ensureOpen();

    if (this.options.readonly && isMutatingStatement(sql)) {
      throw new Error('bun:sqlite: database opened in readonly mode');
    }

    const normalizedParams = normalizeExecParams(params);
    const result = this.db.exec(sql, normalizedParams.map(decodeParam));

    if (isMutatingStatement(sql)) {
      this.recordMutation(sql, normalizedParams);
    }

    return result;
  }

  _run(sql: string, params: unknown[] = []): RunResult {
    const result = this._execute(sql, params);

    return {
      changes: inferChanges(result),
      lastInsertRowid: inferLastInsertRowid(result),
    };
  }

  query<TRow = Record<string, unknown>>(sql: string): Statement<TRow> {
    return new Statement<TRow>(this, sql);
  }

  prepare<TRow = Record<string, unknown>>(sql: string): Statement<TRow> {
    return this.query<TRow>(sql);
  }

  exec(sql: string, ...params: unknown[]): unknown {
    return this._execute(sql, params);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    return this._run(sql, params);
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return ((...args: TArgs): TResult => {
      const journalLengthBefore = this.journal.length;

      try {
        const result = fn(...args);

        if (result && typeof (result as { then?: unknown }).then === 'function') {
          const promiseResult = result as unknown as Promise<unknown>;
          return promiseResult
            .then(value => value)
            .catch((error) => {
              this.rollbackToJournalLength(journalLengthBefore);
              throw error;
            }) as unknown as TResult;
        }

        return result;
      } catch (error) {
        this.rollbackToJournalLength(journalLengthBefore);
        throw error;
      }
    }) as (...args: TArgs) => TResult;
  }

  serialize(): Uint8Array {
    this.ensureOpen();

    const payload = {
      version: 1,
      filename: this.filename,
      journal: this.journal.map(cloneEntry),
    };

    return new TextEncoder().encode(JSON.stringify(payload));
  }

  close(_throwOnError: boolean = false): void {
    if (this.closed) {
      return;
    }

    this.persistJournal();
    this.closed = true;
  }

  loadExtension(_path: string): void {
    throw new Error('bun:sqlite: loadExtension is not available in browser runtime');
  }

  static open(filename: string = ':memory:', options: DatabaseOptions = {}): Database {
    return new Database(filename, options);
  }

  static deserialize(data: Uint8Array, filename: string = ':memory:'): Database {
    const decoded = new TextDecoder().decode(data);
    const parsed = JSON.parse(decoded) as { journal?: JournalEntry[] };

    if (filename !== ':memory:') {
      persistedJournals.set(filename, (parsed.journal ?? []).map(cloneEntry));
    }

    const db = new Database(filename, { create: true, readwrite: true, readonly: false });

    if (filename === ':memory:' && Array.isArray(parsed.journal) && parsed.journal.length > 0) {
      for (const entry of parsed.journal) {
        db._execute(entry.sql, entry.params.map(decodeParam));
      }
    }

    return db;
  }
}

export const constants = {
  SQLITE_OK: 0,
  SQLITE_ERROR: 1,
  SQLITE_BUSY: 5,
  SQLITE_LOCKED: 6,
  SQLITE_READONLY: 8,
  SQLITE_IOERR: 10,
};

export function clearPersistedDatabases(): void {
  persistedJournals.clear();
}

export default {
  Database,
  Statement,
  constants,
  clearPersistedDatabases,
};
