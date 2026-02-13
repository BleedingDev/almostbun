import { Database as BunSqliteDatabase, Statement as BunSqliteStatement } from './bun-sqlite';

export interface BetterSqlite3Options {
  readonly?: boolean;
  fileMustExist?: boolean;
  memory?: boolean;
  timeout?: number;
  verbose?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

type Row = Record<string, unknown>;

class BetterSqlite3Statement {
  constructor(private readonly statement: BunSqliteStatement<Row>) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | null } {
    return this.statement.run(...params);
  }

  get(...params: unknown[]): Row | null {
    return this.statement.get(...params);
  }

  all(...params: unknown[]): Row[] {
    return this.statement.all(...params);
  }

  iterate(...params: unknown[]): IterableIterator<Row> {
    return this.statement.iterate(...params);
  }

  pluck(_toggle: boolean = true): this {
    return this;
  }

  raw(_toggle: boolean = true): this {
    return this;
  }

  expand(_toggle: boolean = true): this {
    return this;
  }

  bind(..._params: unknown[]): this {
    return this;
  }

  columns(): Array<{ name: string }> {
    return [];
  }
}

export class Database {
  private readonly db: BunSqliteDatabase;

  constructor(filename: string = ':memory:', options: BetterSqlite3Options = {}) {
    const resolvedFilename = options.memory ? ':memory:' : filename;
    this.db = new BunSqliteDatabase(resolvedFilename, {
      create: !options.fileMustExist,
      readonly: !!options.readonly,
      readwrite: !options.readonly,
    });
  }

  prepare(sql: string): BetterSqlite3Statement {
    return new BetterSqlite3Statement(this.db.prepare<Row>(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  pragma(statement: string, options?: { simple?: boolean }): unknown {
    const rows = this.db.query<Row>(`PRAGMA ${statement}`).all();
    if (!options?.simple) {
      return rows;
    }
    if (rows.length === 0) {
      return undefined;
    }
    const first = rows[0];
    const firstValue = Object.values(first)[0];
    return firstValue;
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return this.db.transaction(fn);
  }

  close(): this {
    this.db.close(false);
    return this;
  }

  backup(_filename?: string): Promise<void> {
    return Promise.resolve();
  }

  serialize(options?: { attached?: unknown }): Uint8Array {
    void options;
    return this.db.serialize();
  }

  loadExtension(path: string): void {
    this.db.loadExtension(path);
  }
}

export class SqliteError extends Error {
  code: string;
  errno?: number;

  constructor(message: string, code = 'SQLITE_ERROR', errno?: number) {
    super(message);
    this.name = 'SqliteError';
    this.code = code;
    this.errno = errno;
  }
}

export default Database;
