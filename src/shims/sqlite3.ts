import { Database as BunSqliteDatabase } from './bun-sqlite';

type SqliteCallback<T = unknown> = (this: unknown, err: Error | null, result?: T) => void;

function defer(callback: () => void): void {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
}

function normalizeParams(args: unknown[]): { params: unknown[]; callback?: SqliteCallback } {
  if (args.length === 0) {
    return { params: [] };
  }

  const maybeCallback = args[args.length - 1];
  const callback = typeof maybeCallback === 'function' ? (maybeCallback as SqliteCallback) : undefined;
  const values = callback ? args.slice(0, -1) : args;

  if (values.length === 1 && Array.isArray(values[0])) {
    return { params: values[0] as unknown[], callback };
  }

  return { params: values, callback };
}

export const OPEN_READONLY = 0x0001;
export const OPEN_READWRITE = 0x0002;
export const OPEN_CREATE = 0x0004;

export class Statement {
  constructor(private readonly db: Database, private readonly sql: string) {}

  run(...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const result = this.db.__inner.run(this.sql, ...params);
      if (callback) {
        const context = {
          lastID: result.lastInsertRowid ?? null,
          changes: result.changes ?? 0,
        };
        defer(() => callback.call(context, null));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  get(...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const row = this.db.__inner.query(this.sql).get(...params);
      if (callback) {
        defer(() => callback.call(this, null, row));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  all(...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const rows = this.db.__inner.query(this.sql).all(...params);
      if (callback) {
        defer(() => callback.call(this, null, rows));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  finalize(callback?: (err: Error | null) => void): this {
    if (callback) {
      defer(() => callback(null));
    }
    return this;
  }
}

export class Database {
  readonly __inner: BunSqliteDatabase;

  constructor(
    filename: string = ':memory:',
    modeOrCallback?: number | ((err: Error | null) => void),
    callback?: (err: Error | null) => void
  ) {
    const mode = typeof modeOrCallback === 'number'
      ? modeOrCallback
      : OPEN_READWRITE | OPEN_CREATE;
    const openCallback = typeof modeOrCallback === 'function'
      ? modeOrCallback
      : callback;

    this.__inner = new BunSqliteDatabase(filename, {
      create: (mode & OPEN_CREATE) === OPEN_CREATE,
      readwrite: (mode & OPEN_READWRITE) === OPEN_READWRITE,
      readonly: (mode & OPEN_READONLY) === OPEN_READONLY && (mode & OPEN_READWRITE) !== OPEN_READWRITE,
    });

    if (openCallback) {
      defer(() => openCallback(null));
    }
  }

  run(sql: string, ...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const result = this.__inner.run(sql, ...params);
      if (callback) {
        const context = {
          lastID: result.lastInsertRowid ?? null,
          changes: result.changes ?? 0,
        };
        defer(() => callback.call(context, null));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  get(sql: string, ...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const row = this.__inner.query(sql).get(...params);
      if (callback) {
        defer(() => callback.call(this, null, row));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  all(sql: string, ...args: unknown[]): this {
    const { params, callback } = normalizeParams(args);
    try {
      const rows = this.__inner.query(sql).all(...params);
      if (callback) {
        defer(() => callback.call(this, null, rows));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  each(
    sql: string,
    ...args: unknown[]
  ): this {
    let completion: ((err: Error | null, count: number) => void) | undefined;
    let rowCallback: ((err: Error | null, row: unknown) => void) | undefined;

    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      completion = args.pop() as (err: Error | null, count: number) => void;
    }
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      rowCallback = args.pop() as (err: Error | null, row: unknown) => void;
    }

    const { params } = normalizeParams(args);
    try {
      const rows = this.__inner.query(sql).all(...params);
      if (rowCallback) {
        for (const row of rows) {
          defer(() => rowCallback?.(null, row));
        }
      }
      if (completion) {
        defer(() => completion?.(null, rows.length));
      }
    } catch (error) {
      if (completion) {
        defer(() => completion?.(error as Error, 0));
      } else if (rowCallback) {
        defer(() => rowCallback?.(error as Error, null));
      } else {
        throw error;
      }
    }
    return this;
  }

  exec(sql: string, callback?: SqliteCallback): this {
    try {
      this.__inner.exec(sql);
      if (callback) {
        defer(() => callback.call(this, null));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback.call(this, error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }

  prepare(sql: string, ...args: unknown[]): Statement {
    const statement = new Statement(this, sql);
    if (args.length > 0) {
      statement.run(...args);
    }
    return statement;
  }

  serialize(callback?: () => void): this {
    if (callback) {
      defer(callback);
    }
    return this;
  }

  parallelize(callback?: () => void): this {
    if (callback) {
      defer(callback);
    }
    return this;
  }

  configure(_option: string, _value: unknown): this {
    return this;
  }

  interrupt(): this {
    return this;
  }

  close(callback?: (err: Error | null) => void): this {
    try {
      this.__inner.close(false);
      if (callback) {
        defer(() => callback(null));
      }
    } catch (error) {
      if (callback) {
        defer(() => callback(error as Error));
      } else {
        throw error;
      }
    }
    return this;
  }
}

export const cached = {
  Database,
};

export function verbose() {
  return sqlite3;
}

const sqlite3 = {
  Database,
  Statement,
  cached,
  verbose,
  OPEN_READONLY,
  OPEN_READWRITE,
  OPEN_CREATE,
};

export default sqlite3;
