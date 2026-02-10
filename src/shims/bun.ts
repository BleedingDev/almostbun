/**
 * bun module shim for browser runtime.
 *
 * Includes Bun global APIs, S3 compatibility primitives, and utility helpers.
 */

import type { FsShim } from './fs';
import type { Process } from './process';
import * as pathShim from './path';
import { Buffer } from './stream';
import { getServerBridge, type IVirtualServer } from '../server-bridge';
import {
  Database,
  Statement,
  constants as sqliteConstants,
  type RunResult,
} from './bun-sqlite';

export interface S3ClientOptions {
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

interface S3ObjectRecord {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: number;
}

export interface S3ObjectStat {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  lastModified: Date;
  contentType: string;
}

export interface S3ListEntry extends S3ObjectStat {
  url: string;
}

export interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch?: (request: Request, server: BunServer) => Response | Promise<Response>;
}

export interface BunServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: URL;
  fetch: (request: Request) => Promise<Response>;
  stop: (closeActiveConnections?: boolean) => void;
  reload: (options?: Partial<BunServeOptions>) => void;
}

export type BunWriteInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Response
  | BunFile
  | S3File;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const contentTypeByExtension: Record<string, string> = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.wasm': 'application/wasm',
};

const s3Storage = new Map<string, S3ObjectRecord>();

function normalizeS3StorageKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

function guessContentType(path: string): string {
  const ext = pathShim.extname(path).toLowerCase();
  return contentTypeByExtension[ext] ?? 'application/octet-stream';
}

function toUint8ArrayView(data: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function toUint8Array(data: BunWriteInput): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return textEncoder.encode(data);
  }

  if (data instanceof BunFile || data instanceof S3File) {
    return data.bytes();
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  if (typeof Response !== 'undefined' && data instanceof Response) {
    return new Uint8Array(await data.arrayBuffer());
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return toUint8ArrayView(data);
  }

  return textEncoder.encode(String(data));
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function normalizeTargetPath(pathLike: string | URL): string {
  if (pathLike instanceof URL) {
    if (pathLike.protocol === 'file:') {
      return decodeURIComponent(pathLike.pathname);
    }
    return pathLike.toString();
  }

  if (pathLike.startsWith('file://')) {
    return decodeURIComponent(new URL(pathLike).pathname);
  }

  return pathLike;
}

function isS3Path(pathLike: string): boolean {
  return pathLike.startsWith('s3://');
}

function isHttpPath(pathLike: string): boolean {
  return pathLike.startsWith('http://') || pathLike.startsWith('https://');
}

function parseS3Target(pathLike: string | URL, defaultBucket?: string): { bucket: string; key: string } {
  const normalized = normalizeTargetPath(pathLike);

  if (normalized.startsWith('s3://')) {
    const withoutProtocol = normalized.slice(5);
    const slashIndex = withoutProtocol.indexOf('/');

    if (slashIndex < 0) {
      return {
        bucket: withoutProtocol,
        key: '',
      };
    }

    return {
      bucket: withoutProtocol.slice(0, slashIndex),
      key: withoutProtocol.slice(slashIndex + 1),
    };
  }

  if (!defaultBucket) {
    throw new Error('bun:s3: bucket is required for non-s3:// paths');
  }

  const normalizedKey = normalized.replace(/^\/+/, '');
  return {
    bucket: defaultBucket,
    key: normalizedKey,
  };
}

function bufferToHex(input: Uint8Array): string {
  let output = '';
  for (const byte of input) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

function createEtag(bytes: Uint8Array): string {
  // Bun uses different hashing internally; this is deterministic for browser shim storage.
  return bufferToHex(bytes.subarray(0, Math.min(bytes.length, 16))).padEnd(32, '0');
}

export class S3Client {
  readonly options: S3ClientOptions;

  constructor(options: S3ClientOptions = {}) {
    this.options = { ...options };
  }

  file(pathLike: string | URL, options: { bucket?: string } = {}): S3File {
    const { bucket, key } = parseS3Target(pathLike, options.bucket ?? this.options.bucket);
    return new S3File(this, bucket, key);
  }

  async write(pathLike: string | URL, data: BunWriteInput, options: { bucket?: string } = {}): Promise<number> {
    return this.file(pathLike, options).write(data);
  }

  async delete(pathLike: string | URL, options: { bucket?: string } = {}): Promise<void> {
    await this.file(pathLike, options).delete();
  }

  async exists(pathLike: string | URL, options: { bucket?: string } = {}): Promise<boolean> {
    return this.file(pathLike, options).exists();
  }

  async stat(pathLike: string | URL, options: { bucket?: string } = {}): Promise<S3ObjectStat | null> {
    return this.file(pathLike, options).stat();
  }

  async list(prefix = '', options: { bucket?: string } = {}): Promise<S3ListEntry[]> {
    const bucket = options.bucket ?? this.options.bucket;
    if (!bucket) {
      throw new Error('bun:s3: bucket is required to list objects');
    }

    const normalizedPrefix = prefix.replace(/^\/+/, '');
    const result: S3ListEntry[] = [];

    for (const [storageKey, record] of s3Storage) {
      const bucketPrefix = `${bucket}/`;
      if (!storageKey.startsWith(bucketPrefix)) {
        continue;
      }

      const objectKey = storageKey.slice(bucketPrefix.length);
      if (!objectKey.startsWith(normalizedPrefix)) {
        continue;
      }

      result.push({
        bucket,
        key: objectKey,
        size: record.body.byteLength,
        etag: record.etag,
        lastModified: new Date(record.lastModified),
        contentType: record.contentType,
        url: `s3://${bucket}/${objectKey}`,
      });
    }

    return result.sort((a, b) => a.key.localeCompare(b.key));
  }

  _peekRecord(bucket: string, key: string): S3ObjectRecord | undefined {
    return s3Storage.get(normalizeS3StorageKey(bucket, key));
  }

  _putRecord(bucket: string, key: string, bytes: Uint8Array, contentType?: string): void {
    const payload = cloneBytes(bytes);
    s3Storage.set(normalizeS3StorageKey(bucket, key), {
      body: payload,
      contentType: contentType ?? guessContentType(key),
      etag: createEtag(payload),
      lastModified: Date.now(),
    });
  }

  _deleteRecord(bucket: string, key: string): void {
    s3Storage.delete(normalizeS3StorageKey(bucket, key));
  }
}

export class S3File {
  constructor(
    private readonly client: S3Client,
    public readonly bucket: string,
    public readonly key: string
  ) {}

  get url(): string {
    return `s3://${this.bucket}/${this.key}`;
  }

  get name(): string {
    return pathShim.basename(this.key);
  }

  _peekRecord(): S3ObjectRecord | undefined {
    return this.client._peekRecord(this.bucket, this.key);
  }

  async exists(): Promise<boolean> {
    return this._peekRecord() !== undefined;
  }

  async stat(): Promise<S3ObjectStat | null> {
    const record = this._peekRecord();
    if (!record) {
      return null;
    }

    return {
      bucket: this.bucket,
      key: this.key,
      size: record.body.byteLength,
      etag: record.etag,
      lastModified: new Date(record.lastModified),
      contentType: record.contentType,
    };
  }

  async bytes(): Promise<Uint8Array> {
    const record = this._peekRecord();
    if (!record) {
      throw new Error(`bun:s3: object not found: ${this.url}`);
    }

    return cloneBytes(record.body);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(await this.bytes());
  }

  async text(): Promise<string> {
    return textDecoder.decode(await this.bytes());
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  stream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(await self.bytes());
        controller.close();
      },
    });
  }

  async write(data: BunWriteInput): Promise<number> {
    const bytes = await toUint8Array(data);
    this.client._putRecord(this.bucket, this.key, bytes);
    return bytes.byteLength;
  }

  async delete(): Promise<void> {
    this.client._deleteRecord(this.bucket, this.key);
  }

  toString(): string {
    return this.url;
  }
}

export class BunFile {
  constructor(
    private readonly fs: FsShim,
    private readonly source:
      | { kind: 'local'; path: string }
      | { kind: 'remote'; url: string }
      | { kind: 's3'; file: S3File }
  ) {}

  get name(): string {
    if (this.source.kind === 'local') {
      return pathShim.basename(this.source.path);
    }

    if (this.source.kind === 's3') {
      return this.source.file.name;
    }

    return pathShim.basename(new URL(this.source.url).pathname);
  }

  get type(): string {
    if (this.source.kind === 'remote') {
      return guessContentType(new URL(this.source.url).pathname);
    }

    if (this.source.kind === 's3') {
      const record = this.source.file._peekRecord();
      return record?.contentType ?? guessContentType(this.source.file.key);
    }

    return guessContentType(this.source.path);
  }

  get size(): number {
    if (this.source.kind === 'local') {
      try {
        return this.fs.statSync(this.source.path).size;
      } catch {
        return 0;
      }
    }

    if (this.source.kind === 's3') {
      const record = this.source.file._peekRecord();
      return record?.body.byteLength ?? 0;
    }

    return 0;
  }

  async exists(): Promise<boolean> {
    if (this.source.kind === 'local') {
      return this.fs.existsSync(this.source.path);
    }

    if (this.source.kind === 's3') {
      return this.source.file.exists();
    }

    try {
      const response = await fetch(this.source.url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async bytes(): Promise<Uint8Array> {
    if (this.source.kind === 'local') {
      return toUint8ArrayView(this.fs.readFileSync(this.source.path));
    }

    if (this.source.kind === 's3') {
      return this.source.file.bytes();
    }

    const response = await fetch(this.source.url);
    if (!response.ok) {
      throw new Error(`bun:file: failed to fetch ${this.source.url}: ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(await this.bytes());
  }

  async text(): Promise<string> {
    return textDecoder.decode(await this.bytes());
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  stream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(await self.bytes());
        controller.close();
      },
    });
  }

  async write(data: BunWriteInput): Promise<number> {
    const bytes = await toUint8Array(data);

    if (this.source.kind === 'local') {
      this.fs.writeFileSync(this.source.path, bytes);
      return bytes.byteLength;
    }

    if (this.source.kind === 's3') {
      return this.source.file.write(bytes);
    }

    throw new Error('bun:file: cannot write to remote HTTP file');
  }

  toString(): string {
    if (this.source.kind === 'local') {
      return this.source.path;
    }

    if (this.source.kind === 's3') {
      return this.source.file.toString();
    }

    return this.source.url;
  }
}

export interface BunSqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown[];
  query: (source: string, ...params: unknown[]) => unknown[];
  run: (source: string, ...params: unknown[]) => RunResult;
  close: () => void;
  database: Database;
}

function createBunSqlTag(): BunSqlTag {
  const db = new Database(':memory:');

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]): unknown[] => {
    const params: unknown[] = [];
    let source = '';

    for (let i = 0; i < strings.length; i += 1) {
      source += strings[i];
      if (i < values.length) {
        source += '?';
        params.push(values[i]);
      }
    }

    return db.query(source).all(...params);
  }) as BunSqlTag;

  tag.query = (source: string, ...params: unknown[]): unknown[] => {
    return db.query(source).all(...params);
  };

  tag.run = (source: string, ...params: unknown[]): RunResult => {
    return db.run(source, ...params);
  };

  tag.close = (): void => {
    db.close();
  };

  tag.database = db;

  return tag;
}

function fnv1aHash(bytes: Uint8Array): number {
  let hashValue = 0x811c9dc5;

  for (const byte of bytes) {
    hashValue ^= byte;
    hashValue = Math.imul(hashValue, 0x01000193);
  }

  return hashValue >>> 0;
}

function resolveExecutablePath(fs: FsShim, process: Process, binName: string): string | null {
  if (!binName) {
    return null;
  }

  if (binName.includes('/')) {
    return fs.existsSync(binName) ? binName : null;
  }

  const pathEnv = process.env.PATH ?? '';
  const parts = pathEnv.split(':').filter(Boolean);

  for (const part of parts) {
    const candidate = part.endsWith('/') ? `${part}${binName}` : `${part}/${binName}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function createServeShim(initialOptions: BunServeOptions): BunServer {
  let options: BunServeOptions = {
    port: initialOptions.port ?? 3000,
    hostname: initialOptions.hostname ?? '127.0.0.1',
    fetch: initialOptions.fetch,
  };

  let stopped = false;
  const bridge = getServerBridge();
  let registeredPort: number | null = null;
  let virtualServer: IVirtualServer | null = null;

  const server: BunServer = {
    get port() {
      return options.port ?? 3000;
    },

    get hostname() {
      return options.hostname ?? '127.0.0.1';
    },

    get url() {
      return new URL(`http://${server.hostname}:${server.port}/`);
    },

    async fetch(request: Request): Promise<Response> {
      if (stopped) {
        return new Response('Server stopped', { status: 503 });
      }

      if (!options.fetch) {
        return new Response('Bun.serve shim is active, but no fetch handler was provided.', {
          status: 501,
        });
      }

      return options.fetch(request, server);
    },

    stop(): void {
      stopped = true;
      if (registeredPort !== null) {
        bridge.unregisterServer(registeredPort);
        registeredPort = null;
      }
      virtualServer = null;
    },

    reload(nextOptions?: Partial<BunServeOptions>): void {
      options = {
        ...options,
        ...nextOptions,
      };
      stopped = false;
      registerVirtualServer();
    },
  };

  const toResponseData = async (response: Response) => {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    return {
      statusCode: response.status,
      statusMessage: response.statusText || (response.ok ? 'OK' : 'Error'),
      headers,
      body,
    };
  };

  const registerVirtualServer = () => {
    if (!options.fetch) {
      if (registeredPort !== null) {
        bridge.unregisterServer(registeredPort);
        registeredPort = null;
      }
      virtualServer = null;
      return;
    }

    const targetPort = options.port ?? 3000;
    const targetHost = options.hostname ?? '127.0.0.1';

    if (registeredPort !== null && registeredPort !== targetPort) {
      bridge.unregisterServer(registeredPort);
      registeredPort = null;
    }

    virtualServer = {
      get listening() {
        return !stopped;
      },
      address() {
        return {
          port: targetPort,
          address: targetHost,
          family: 'IPv4',
        };
      },
      async handleRequest(method, url, headers, body) {
        try {
          const requestUrl = /^https?:\/\//.test(url)
            ? url
            : new URL(url, `http://${targetHost}:${targetPort}/`).toString();
          const request = new Request(requestUrl, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD'
              ? undefined
              : body instanceof Buffer
                ? body
                : body
                  ? String(body)
                  : undefined,
          });

          const response = await server.fetch(request);
          return toResponseData(response);
        } catch (error) {
          return {
            statusCode: 500,
            statusMessage: 'Internal Server Error',
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            body: Buffer.from(String(error)),
          };
        }
      },
    };

    bridge.registerServer(virtualServer, targetPort, targetHost);
    registeredPort = targetPort;
  };

  registerVirtualServer();

  return server;
}

export interface BunModule {
  readonly version: string;
  readonly revision: string;
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly Bun: BunModule;
  file: (pathLike: string | URL) => BunFile;
  write: (pathOrFile: string | URL | BunFile | S3File, data: BunWriteInput) => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
  sleepSync: (milliseconds: number) => void;
  hash: (input: string | Uint8Array | ArrayBuffer | ArrayBufferView) => number;
  which: (binName: string) => string | null;
  inspect: (value: unknown) => string;
  gc: (force?: boolean) => void;
  cwd: () => string;
  serve: (options?: BunServeOptions) => BunServer;
  S3Client: typeof S3Client;
  s3: (pathLike: string | URL, options?: S3ClientOptions) => S3File;
  sql: BunSqlTag;
  SQLite: {
    Database: typeof Database;
    Statement: typeof Statement;
    constants: typeof sqliteConstants;
  };
}

export function createBunModule(fs: FsShim, process: Process): BunModule {
  const defaultS3Client = new S3Client();
  const sql = createBunSqlTag();

  const file = (pathLike: string | URL): BunFile => {
    const normalized = normalizeTargetPath(pathLike);

    if (isS3Path(normalized)) {
      return new BunFile(fs, {
        kind: 's3',
        file: defaultS3Client.file(normalized),
      });
    }

    if (isHttpPath(normalized)) {
      return new BunFile(fs, {
        kind: 'remote',
        url: normalized,
      });
    }

    return new BunFile(fs, {
      kind: 'local',
      path: normalized,
    });
  };

  const write = async (
    pathOrFile: string | URL | BunFile | S3File,
    data: BunWriteInput
  ): Promise<number> => {
    if (pathOrFile instanceof BunFile || pathOrFile instanceof S3File) {
      return pathOrFile.write(data);
    }

    const normalized = normalizeTargetPath(pathOrFile);

    if (isS3Path(normalized)) {
      return defaultS3Client.file(normalized).write(data);
    }

    const bytes = await toUint8Array(data);
    fs.writeFileSync(normalized, bytes);
    return bytes.byteLength;
  };

  const sleep = async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
  };

  const sleepSync = (milliseconds: number): void => {
    const duration = Math.max(0, milliseconds);

    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new SharedArrayBuffer(4);
      const view = new Int32Array(shared);
      Atomics.wait(view, 0, 0, duration);
      return;
    }

    const start = Date.now();
    while (Date.now() - start < duration) {
      // Busy wait fallback when Atomics.wait is unavailable.
    }
  };

  const hash = (input: string | Uint8Array | ArrayBuffer | ArrayBufferView): number => {
    if (typeof input === 'string') {
      return fnv1aHash(textEncoder.encode(input));
    }

    return fnv1aHash(toUint8ArrayView(input));
  };

  const inspect = (value: unknown): string => {
    try {
      if (typeof value === 'string') {
        return value;
      }
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const gc = (): void => {
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    if (typeof maybeGc === 'function') {
      maybeGc();
    }
  };

  const serve = (options: BunServeOptions = {}): BunServer => {
    return createServeShim(options);
  };

  const s3 = (pathLike: string | URL, options: S3ClientOptions = {}): S3File => {
    if (Object.keys(options).length > 0) {
      const merged = new S3Client({
        ...defaultS3Client.options,
        ...options,
      });
      return merged.file(pathLike, {
        bucket: options.bucket,
      });
    }

    return defaultS3Client.file(pathLike);
  };

  const bun = {
    version: '1.3.0-browser-shim',
    revision: 'shim',
    argv: process.argv,
    env: process.env,
    Bun: null as unknown as BunModule,
    file,
    write,
    sleep,
    sleepSync,
    hash,
    which: (binName: string): string | null => resolveExecutablePath(fs, process, binName),
    inspect,
    gc,
    cwd: (): string => process.cwd(),
    serve,
    S3Client,
    s3,
    sql,
    SQLite: {
      Database,
      Statement,
      constants: sqliteConstants,
    },
  } as BunModule;

  Object.defineProperty(bun, 'env', {
    enumerable: true,
    get() {
      return process.env;
    },
  });

  Object.defineProperty(bun, 'argv', {
    enumerable: true,
    get() {
      return process.argv;
    },
  });

  (bun as { Bun: BunModule }).Bun = bun;

  return bun;
}

export function s3(pathLike: string | URL, options: S3ClientOptions = {}): S3File {
  const client = new S3Client(options);
  return client.file(pathLike, {
    bucket: options.bucket,
  });
}

export default {
  createBunModule,
  BunFile,
  S3Client,
  S3File,
  Database,
  Statement,
  s3,
};
