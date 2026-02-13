/**
 * Virtual File System - In-memory file tree with POSIX-like operations
 */

import type { VFSSnapshot, VFSFileEntry } from './runtime-interface';
import { uint8ToBase64, base64ToUint8 } from './utils/binary-encoding';

export interface FSNode {
  type: 'file' | 'directory' | 'symlink';
  content?: Uint8Array;
  children?: Map<string, FSNode>;
  target?: string;
  mtime: number;
}

// Simple EventEmitter for VFS change notifications
type VFSChangeListener = (path: string, content: string) => void;
type VFSDeleteListener = (path: string) => void;
type VFSEventListener = VFSChangeListener | VFSDeleteListener;

export interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  rdev: number;
  blksize: number;
  blocks: number;
}

export type WatchEventType = 'change' | 'rename';
export type WatchListener = (eventType: WatchEventType, filename: string | null) => void;

export interface FSWatcher {
  close(): void;
  ref(): this;
  unref(): this;
}

interface WatcherEntry {
  listener: WatchListener;
  recursive: boolean;
  closed: boolean;
}

/**
 * Create a Node.js-style error with code property
 */
export interface NodeError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
}

export function createNodeError(
  code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP' | 'EINVAL',
  syscall: string,
  path: string,
  message?: string
): NodeError {
  const errno: Record<string, number> = {
    ENOENT: -2,
    ENOTDIR: -20,
    EISDIR: -21,
    EEXIST: -17,
    ENOTEMPTY: -39,
    ELOOP: -40,
    EINVAL: -22,
  };

  const messages: Record<string, string> = {
    ENOENT: 'no such file or directory',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'file already exists',
    ENOTEMPTY: 'directory not empty',
    ELOOP: 'too many symbolic links encountered',
    EINVAL: 'invalid argument',
  };

  const err = new Error(
    message || `${code}: ${messages[code]}, ${syscall} '${path}'`
  ) as NodeError;
  err.code = code;
  err.errno = errno[code];
  err.syscall = syscall;
  err.path = path;
  return err;
}

export class VirtualFS {
  private static readonly MAX_SYMLINK_DEPTH = 40;
  private root: FSNode;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private watchers = new Map<string, Set<WatcherEntry>>();
  private eventListeners = new Map<string, Set<VFSEventListener>>();

  constructor() {
    this.root = {
      type: 'directory',
      children: new Map(),
      mtime: Date.now(),
    };
  }

  /**
   * Add event listener (for change notifications to workers)
   */
  on(event: 'change', listener: VFSChangeListener): this;
  on(event: 'delete', listener: VFSDeleteListener): this;
  on(event: string, listener: VFSEventListener): this {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
    return this;
  }

  /**
   * Remove event listener
   */
  off(event: 'change', listener: VFSChangeListener): this;
  off(event: 'delete', listener: VFSDeleteListener): this;
  off(event: string, listener: VFSEventListener): this {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
    return this;
  }

  /**
   * Emit event to listeners
   */
  private emit(event: 'change', path: string, content: string): void;
  private emit(event: 'delete', path: string): void;
  private emit(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as (...args: unknown[]) => void)(...args);
        } catch (err) {
          console.error('Error in VFS event listener:', err);
        }
      }
    }
  }

  /**
   * Serialize the entire file tree to a snapshot (for worker transfer)
   */
  toSnapshot(): VFSSnapshot {
    const files: VFSFileEntry[] = [];
    this.serializeNode('/', this.root, files);
    return { files };
  }

  private serializeNode(path: string, node: FSNode, files: VFSFileEntry[]): void {
    if (node.type === 'file') {
      // Encode binary content as base64
      let content = '';
      if (node.content && node.content.length > 0) {
        content = uint8ToBase64(node.content);
      }
      files.push({ path, type: 'file', content });
    } else if (node.type === 'symlink') {
      files.push({ path, type: 'symlink', target: node.target || '' });
    } else if (node.type === 'directory') {
      files.push({ path, type: 'directory' });
      if (node.children) {
        for (const [name, child] of node.children) {
          const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
          this.serializeNode(childPath, child, files);
        }
      }
    }
  }

  /**
   * Create a VirtualFS from a snapshot
   */
  static fromSnapshot(snapshot: VFSSnapshot): VirtualFS {
    const vfs = new VirtualFS();

    // Sort entries to ensure directories are created before their contents
    const sortedFiles = snapshot.files
      .map((entry, i) => ({ entry, depth: entry.path.split('/').length, i }))
      .sort((a, b) => a.depth - b.depth || a.i - b.i)
      .map(x => x.entry);

    for (const entry of sortedFiles) {
      if (entry.path === '/') continue; // Skip root

      if (entry.type === 'directory') {
        vfs.mkdirSync(entry.path, { recursive: true });
      } else if (entry.type === 'symlink') {
        const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
        if (parentPath !== '/' && !vfs.existsSync(parentPath)) {
          vfs.mkdirSync(parentPath, { recursive: true });
        }
        vfs.symlinkSync(entry.target || '', entry.path);
      } else if (entry.type === 'file') {
        // Decode base64 content
        let content: Uint8Array;
        if (entry.content) {
          content = base64ToUint8(entry.content);
        } else {
          content = new Uint8Array(0);
        }
        // Ensure parent directory exists
        const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
        if (parentPath !== '/' && !vfs.existsSync(parentPath)) {
          vfs.mkdirSync(parentPath, { recursive: true });
        }
        vfs.writeFileSyncInternal(entry.path, content, false); // Don't emit events during restore
      }
    }

    return vfs;
  }

  /**
   * Internal write that optionally emits events
   */
  private writeFileSyncInternal(path: string, data: string | Uint8Array, emitEvent: boolean): void {
    const requestedPath = this.normalizePath(path);
    const writablePath = this.resolveWritablePath(path);
    const parentPath = this.getParentPath(writablePath);
    const basename = this.getBasename(writablePath);

    if (!basename) {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
    }

    const parent = this.ensureDirectory(parentPath);
    const existing = parent.children!.get(basename);
    if (existing?.type === 'directory') {
      throw createNodeError('EISDIR', 'open', path);
    }
    const existed = !!existing;

    const content = typeof data === 'string' ? this.encoder.encode(data) : data;

    parent.children!.set(basename, {
      type: 'file',
      content,
      mtime: Date.now(),
    });

    if (emitEvent) {
      const eventPaths = requestedPath === writablePath
        ? [requestedPath]
        : [requestedPath, writablePath];
      const textContent = typeof data === 'string' ? data : this.decoder.decode(data);

      // Notify watchers
      for (const eventPath of eventPaths) {
        this.notifyWatchers(eventPath, existed ? 'change' : 'rename');
      }
      // Emit change event for worker sync
      for (const eventPath of eventPaths) {
        this.emit('change', eventPath, textContent);
      }
    }
  }

  /**
   * Normalize path - resolve . and .. segments, ensure leading /
   */
  private normalizePath(path: string): string {
    if (!path.startsWith('/')) {
      path = '/' + path;
    }

    const parts = path.split('/').filter(Boolean);
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else if (part !== '.') {
        resolved.push(part);
      }
    }

    return '/' + resolved.join('/');
  }

  private toAbsolutePath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  private getTraversalSegments(path: string): string[] {
    return this
      .toAbsolutePath(path)
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.');
  }

  /**
   * Get path segments from normalized path
   */
  private getPathSegments(path: string): string[] {
    return this.normalizePath(path).split('/').filter(Boolean);
  }

  /**
   * Get parent directory path
   */
  private getParentPath(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : normalized.slice(0, lastSlash);
  }

  /**
   * Get basename from path
   */
  private getBasename(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return normalized.slice(lastSlash + 1);
  }

  /**
   * Resolve a symlink target from the symlink's parent directory
   */
  private resolveSymlinkTarget(target: string, symlinkParentSegments: string[]): string {
    if (target.startsWith('/')) {
      return this.normalizePath(target);
    }
    const joined = ['/', ...symlinkParentSegments, target].join('/');
    return this.normalizePath(joined);
  }

  /**
   * Resolve node at path with optional final symlink traversal
   */
  private resolveNode(path: string, syscall: string, followFinalSymlink: boolean): {
    node: FSNode;
    resolvedPath: string;
  } {
    let segments = this.getTraversalSegments(path);
    let current = this.root;
    let resolvedSegments: string[] = [];
    let resolvedNodes: FSNode[] = [this.root];
    let symlinkDepth = 0;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];

      if (current.type !== 'directory' || !current.children) {
        throw createNodeError('ENOTDIR', syscall, path);
      }

      if (segment === '..') {
        if (resolvedSegments.length > 0) {
          resolvedSegments.pop();
          resolvedNodes.pop();
        }
        current = resolvedNodes[resolvedNodes.length - 1] || this.root;
        continue;
      }

      const child = current.children.get(segment);
      if (!child) {
        throw createNodeError('ENOENT', syscall, path);
      }

      const isLast = index === segments.length - 1;
      if (child.type === 'symlink' && (!isLast || followFinalSymlink)) {
        symlinkDepth += 1;
        if (symlinkDepth > VirtualFS.MAX_SYMLINK_DEPTH) {
          throw createNodeError('ELOOP', syscall, path);
        }

        const targetPath = this.resolveSymlinkTarget(child.target || '', resolvedSegments);
        const remaining = segments.slice(index + 1);
        segments = [...this.getTraversalSegments(targetPath), ...remaining];
        current = this.root;
        resolvedSegments = [];
        resolvedNodes = [this.root];
        index = -1;
        continue;
      }

      current = child;
      resolvedSegments.push(segment);
      resolvedNodes.push(child);
    }

    const resolvedPath = resolvedSegments.length === 0 ? '/' : `/${resolvedSegments.join('/')}`;
    return { node: current, resolvedPath };
  }

  /**
   * Resolve writable destination path (follows final symlink if present)
   */
  private resolveWritablePath(path: string): string {
    const absolutePath = this.toAbsolutePath(path);
    let lstatResult: { node: FSNode; resolvedPath: string } | null = null;
    try {
      lstatResult = this.resolveNode(absolutePath, 'open', false);
    } catch (error) {
      const err = error as NodeError;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }

    if (!lstatResult) {
      const traversalSegments = this.getTraversalSegments(absolutePath);
      const basename = traversalSegments[traversalSegments.length - 1];
      if (basename && basename !== '..') {
        const parentSegments = traversalSegments.slice(0, -1);
        const parentInputPath = parentSegments.length > 0
          ? `/${parentSegments.join('/')}`
          : '/';
        try {
          const parentResolved = this.resolveNode(parentInputPath, 'open', true);
          if (parentResolved.node.type === 'directory') {
            return parentResolved.resolvedPath === '/'
              ? `/${basename}`
              : `${parentResolved.resolvedPath}/${basename}`;
          }
        } catch (error) {
          const err = error as NodeError;
          if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
            throw error;
          }
        }
      }
      return this.normalizePath(absolutePath);
    }

    if (lstatResult.node.type === 'directory') {
      throw createNodeError('EISDIR', 'open', path);
    }

    if (lstatResult.node.type === 'file') {
      return lstatResult.resolvedPath;
    }

    const symlinkParent = this.getPathSegments(this.getParentPath(lstatResult.resolvedPath));
    const targetPath = this.resolveSymlinkTarget(lstatResult.node.target || '', symlinkParent);
    try {
      const resolvedTarget = this.resolveNode(targetPath, 'open', true);
      if (resolvedTarget.node.type === 'directory') {
        throw createNodeError('EISDIR', 'open', path);
      }
      return resolvedTarget.resolvedPath;
    } catch (error) {
      const err = error as NodeError;
      if (err.code === 'ENOENT') {
        return this.normalizePath(targetPath);
      }
      throw error;
    }
  }

  private createStats(node: FSNode): Stats {
    const size = node.type === 'file'
      ? (node.content?.length || 0)
      : node.type === 'symlink'
        ? (node.target?.length || 0)
        : 0;
    const mtime = node.mtime;
    const mode = node.type === 'directory'
      ? 0o755
      : node.type === 'symlink'
        ? 0o777
        : 0o644;

    return {
      isFile: () => node.type === 'file',
      isDirectory: () => node.type === 'directory',
      isSymbolicLink: () => node.type === 'symlink',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size,
      mode,
      mtime: new Date(mtime),
      atime: new Date(mtime),
      ctime: new Date(mtime),
      birthtime: new Date(mtime),
      mtimeMs: mtime,
      atimeMs: mtime,
      ctimeMs: mtime,
      birthtimeMs: mtime,
      nlink: 1,
      uid: 1000,
      gid: 1000,
      dev: 0,
      ino: 0,
      rdev: 0,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
    };
  }

  /**
   * Get or create directory at path (for mkdir -p behavior)
   */
  private ensureDirectory(path: string): FSNode {
    const segments = this.getPathSegments(path);
    let current = this.root;
    let resolvedSegments: string[] = [];
    let symlinkDepth = 0;

    for (const segment of segments) {
      if (current.type !== 'directory') {
        throw createNodeError('ENOTDIR', 'mkdir', path);
      }
      if (!current.children) {
        current.children = new Map();
      }

      let child = current.children.get(segment);
      if (!child) {
        child = { type: 'directory', children: new Map(), mtime: Date.now() };
        current.children.set(segment, child);
      } else if (child.type === 'symlink') {
        symlinkDepth += 1;
        if (symlinkDepth > VirtualFS.MAX_SYMLINK_DEPTH) {
          throw createNodeError('ELOOP', 'mkdir', path);
        }

        const targetPath = this.resolveSymlinkTarget(child.target || '', resolvedSegments);
        const resolvedTarget = this.resolveNode(targetPath, 'mkdir', true);
        if (resolvedTarget.node.type !== 'directory') {
          throw createNodeError('ENOTDIR', 'mkdir', path);
        }
        current = resolvedTarget.node;
        resolvedSegments = this.getPathSegments(resolvedTarget.resolvedPath);
        continue;
      } else if (child.type !== 'directory') {
        throw createNodeError('ENOTDIR', 'mkdir', path);
      }

      current = child;
      resolvedSegments.push(segment);
    }

    return current;
  }

  /**
   * Check if path exists
   */
  existsSync(path: string): boolean {
    try {
      this.resolveNode(path, 'stat', true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get stats for path
   */
  statSync(path: string): Stats {
    const { node } = this.resolveNode(path, 'stat', true);
    return this.createStats(node);
  }

  /**
   * lstatSync - returns symlink node stats without following final link
   */
  lstatSync(path: string): Stats {
    const { node } = this.resolveNode(path, 'lstat', false);
    return this.createStats(node);
  }

  /**
   * Read file contents as Uint8Array
   */
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: 'utf8' | 'utf-8'): string;
  readFileSync(path: string, encoding?: 'utf8' | 'utf-8'): Uint8Array | string {
    const { node } = this.resolveNode(path, 'open', true);

    if (node.type !== 'file') {
      throw createNodeError('EISDIR', 'read', path);
    }

    const content = node.content || new Uint8Array(0);

    if (encoding === 'utf8' || encoding === 'utf-8') {
      return this.decoder.decode(content);
    }

    return content;
  }

  /**
   * Write data to file, creating parent directories as needed
   */
  writeFileSync(path: string, data: string | Uint8Array): void {
    this.writeFileSyncInternal(path, data, true);
  }

  /**
   * Create directory, optionally with recursive parent creation
   */
  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    const normalized = this.normalizePath(path);

    if (options?.recursive) {
      this.ensureDirectory(normalized);
      return;
    }

    const parentPath = this.getParentPath(normalized);
    const basename = this.getBasename(normalized);

    if (!basename) {
      return; // Root directory already exists
    }

    const { node: parent } = this.resolveNode(parentPath, 'mkdir', true);

    if (parent.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'mkdir', parentPath);
    }

    if (parent.children!.has(basename)) {
      throw createNodeError('EEXIST', 'mkdir', path);
    }

    parent.children!.set(basename, {
      type: 'directory',
      children: new Map(),
      mtime: Date.now(),
    });
  }

  /**
   * Read directory contents
   */
  readdirSync(path: string): string[] {
    const { node } = this.resolveNode(path, 'scandir', true);

    if (node.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'scandir', path);
    }

    return Array.from(node.children!.keys());
  }

  /**
   * Create a symbolic link
   */
  symlinkSync(target: string, path: string): void {
    const normalized = this.normalizePath(path);
    const parentPath = this.getParentPath(normalized);
    const basename = this.getBasename(normalized);

    if (!basename) {
      throw new Error(`EPERM: operation not permitted, symlink '${path}'`);
    }

    const { node: parent } = this.resolveNode(parentPath, 'symlink', true);
    if (parent.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'symlink', parentPath);
    }

    if (parent.children!.has(basename)) {
      throw createNodeError('EEXIST', 'symlink', path);
    }

    parent.children!.set(basename, {
      type: 'symlink',
      target,
      mtime: Date.now(),
    });
    this.notifyWatchers(normalized, 'rename');
  }

  /**
   * Read symbolic link target
   */
  readlinkSync(path: string): string {
    const { node } = this.resolveNode(path, 'readlink', false);
    if (node.type !== 'symlink') {
      throw createNodeError('EINVAL', 'readlink', path);
    }
    return node.target || '';
  }

  /**
   * Remove file
   */
  unlinkSync(path: string): void {
    const normalized = this.normalizePath(path);
    const parentPath = this.getParentPath(normalized);
    const basename = this.getBasename(normalized);

    const { node: parent } = this.resolveNode(parentPath, 'unlink', true);
    if (parent.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'unlink', path);
    }

    const node = parent.children!.get(basename);

    if (!node) {
      throw createNodeError('ENOENT', 'unlink', path);
    }

    if (node.type === 'directory') {
      throw createNodeError('EISDIR', 'unlink', path);
    }

    parent.children!.delete(basename);

    // Notify watchers
    this.notifyWatchers(normalized, 'rename');
    // Emit delete event for worker sync
    this.emit('delete', normalized);
  }

  /**
   * Remove directory (must be empty)
   */
  rmdirSync(path: string): void {
    const normalized = this.normalizePath(path);
    const parentPath = this.getParentPath(normalized);
    const basename = this.getBasename(normalized);

    if (!basename) {
      throw new Error(`EPERM: operation not permitted, '${path}'`);
    }

    const { node: parent } = this.resolveNode(parentPath, 'rmdir', true);
    if (parent.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'rmdir', path);
    }

    const node = parent.children!.get(basename);

    if (!node) {
      throw createNodeError('ENOENT', 'rmdir', path);
    }

    if (node.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'rmdir', path);
    }

    if (node.children!.size > 0) {
      throw createNodeError('ENOTEMPTY', 'rmdir', path);
    }

    parent.children!.delete(basename);
  }

  /**
   * Rename/move file or directory
   */
  renameSync(oldPath: string, newPath: string): void {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);

    const oldParentPath = this.getParentPath(normalizedOld);
    const oldBasename = this.getBasename(normalizedOld);
    const newParentPath = this.getParentPath(normalizedNew);
    const newBasename = this.getBasename(normalizedNew);

    const { node: oldParent } = this.resolveNode(oldParentPath, 'rename', true);
    if (oldParent.type !== 'directory') {
      throw createNodeError('ENOTDIR', 'rename', oldPath);
    }

    const node = oldParent.children!.get(oldBasename);

    if (!node) {
      throw createNodeError('ENOENT', 'rename', oldPath);
    }

    const newParent = this.ensureDirectory(newParentPath);

    oldParent.children!.delete(oldBasename);
    newParent.children!.set(newBasename, node);

    // Notify watchers
    this.notifyWatchers(normalizedOld, 'rename');
    this.notifyWatchers(normalizedNew, 'rename');
  }

  /**
   * Read file with optional options parameter
   */
  readFile(
    path: string,
    optionsOrCallback?: { encoding?: string } | ((err: Error | null, data?: Uint8Array | string) => void),
    callback?: (err: Error | null, data?: Uint8Array | string) => void
  ): void {
    const actualCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    const options = typeof optionsOrCallback === 'object' ? optionsOrCallback : undefined;

    try {
      const data = options?.encoding
        ? this.readFileSync(path, options.encoding as 'utf8')
        : this.readFileSync(path);
      if (actualCallback) {
        setTimeout(() => actualCallback(null, data), 0);
      }
    } catch (err) {
      if (actualCallback) {
        setTimeout(() => actualCallback(err as Error), 0);
      }
    }
  }

  /**
   * Async stat
   */
  stat(path: string, callback: (err: Error | null, stats?: Stats) => void): void {
    try {
      const stats = this.statSync(path);
      setTimeout(() => callback(null, stats), 0);
    } catch (err) {
      setTimeout(() => callback(err as Error), 0);
    }
  }

  /**
   * Async lstat
   */
  lstat(path: string, callback: (err: Error | null, stats?: Stats) => void): void {
    try {
      const stats = this.lstatSync(path);
      setTimeout(() => callback(null, stats), 0);
    } catch (err) {
      setTimeout(() => callback(err as Error), 0);
    }
  }

  /**
   * Async readdir
   */
  readdir(
    path: string,
    optionsOrCallback?: { withFileTypes?: boolean } | ((err: Error | null, files?: string[]) => void),
    callback?: (err: Error | null, files?: string[]) => void
  ): void {
    const actualCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    try {
      const files = this.readdirSync(path);
      if (actualCallback) {
        setTimeout(() => actualCallback(null, files), 0);
      }
    } catch (err) {
      if (actualCallback) {
        setTimeout(() => actualCallback(err as Error), 0);
      }
    }
  }

  /**
   * Async realpath
   */
  realpath(path: string, callback: (err: Error | null, resolvedPath?: string) => void): void {
    try {
      const resolved = this.realpathSync(path);
      setTimeout(() => callback(null, resolved), 0);
    } catch (err) {
      setTimeout(() => callback(err as Error), 0);
    }
  }

  /**
   * Sync realpath - resolves symbolic links
   */
  realpathSync(path: string): string {
    const { resolvedPath } = this.resolveNode(path, 'realpath', true);
    return resolvedPath;
  }

  /**
   * Watch for file changes
   */
  watch(
    filename: string,
    optionsOrListener?: { persistent?: boolean; recursive?: boolean; encoding?: string } | WatchListener,
    listener?: WatchListener
  ): FSWatcher {
    const normalized = this.normalizePath(filename);

    // Parse arguments
    let options: { persistent?: boolean; recursive?: boolean } = {};
    let actualListener: WatchListener | undefined;

    if (typeof optionsOrListener === 'function') {
      actualListener = optionsOrListener;
    } else if (optionsOrListener) {
      options = optionsOrListener;
      actualListener = listener;
    } else {
      actualListener = listener;
    }

    // Create watcher entry
    const entry: WatcherEntry = {
      listener: actualListener || (() => {}),
      recursive: options.recursive || false,
      closed: false,
    };

    // Add to watchers map
    if (!this.watchers.has(normalized)) {
      this.watchers.set(normalized, new Set());
    }
    this.watchers.get(normalized)!.add(entry);

    // Return FSWatcher interface
    const watcher: FSWatcher = {
      close: () => {
        entry.closed = true;
        const watcherSet = this.watchers.get(normalized);
        if (watcherSet) {
          watcherSet.delete(entry);
          if (watcherSet.size === 0) {
            this.watchers.delete(normalized);
          }
        }
      },
      ref: () => watcher,
      unref: () => watcher,
    };

    return watcher;
  }

  /**
   * Notify watchers of file changes
   */
  private notifyWatchers(path: string, eventType: WatchEventType): void {
    const normalized = this.normalizePath(path);
    const basename = this.getBasename(normalized);

    // Check direct watchers on this file
    const directWatchers = this.watchers.get(normalized);
    if (directWatchers) {
      for (const entry of directWatchers) {
        if (!entry.closed) {
          try {
            entry.listener(eventType, basename);
          } catch (err) {
            console.error('Error in file watcher:', err);
          }
        }
      }
    }

    // Check parent directory watchers (recursive and non-recursive)
    let currentPath = this.getParentPath(normalized);
    let relativePath = basename;

    while (currentPath) {
      const parentWatchers = this.watchers.get(currentPath);
      if (parentWatchers) {
        for (const entry of parentWatchers) {
          if (!entry.closed) {
            // Non-recursive watchers only get notified for direct children
            const isDirectChild = this.getParentPath(normalized) === currentPath;
            if (entry.recursive || isDirectChild) {
              try {
                entry.listener(eventType, relativePath);
              } catch (err) {
                console.error('Error in file watcher:', err);
              }
            }
          }
        }
      }

      if (currentPath === '/') break;
      relativePath = this.getBasename(currentPath) + '/' + relativePath;
      currentPath = this.getParentPath(currentPath);
    }
  }

  /**
   * Access check - in our VFS, always succeeds if file exists
   */
  accessSync(path: string, mode?: number): void {
    void mode;
    this.resolveNode(path, 'access', true);
  }

  /**
   * Async access
   */
  access(path: string, modeOrCallback?: number | ((err: Error | null) => void), callback?: (err: Error | null) => void): void {
    const actualCallback = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
    try {
      this.accessSync(path);
      if (actualCallback) setTimeout(() => actualCallback(null), 0);
    } catch (err) {
      if (actualCallback) setTimeout(() => actualCallback(err as Error), 0);
    }
  }

  /**
   * Copy file
   */
  copyFileSync(src: string, dest: string): void {
    const content = this.readFileSync(src);
    this.writeFileSync(dest, content);
  }

  /**
   * Create read stream - simplified implementation
   */
  createReadStream(path: string): {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    once: (event: string, cb: (...args: unknown[]) => void) => void;
    pipe: (dest: unknown) => unknown;
    pause: () => unknown;
    resume: () => unknown;
    destroy: (error?: unknown) => unknown;
    emit: (event: string, ...args: unknown[]) => void;
  } {
    const self = this;
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    let started = false;
    let cachedData: Uint8Array | null = null;
    let cachedError: unknown = null;
    let opened = false;
    let ended = false;
    let closed = false;
    let paused = false;
    let delivered = false;

    const emit = (event: string, ...args: unknown[]): void => {
      const callbacks = listeners[event];
      if (!callbacks || callbacks.length === 0) {
        return;
      }
      // Snapshot listeners so handlers can safely add/remove listeners during emit.
      [...callbacks].forEach((cb) => cb(...args));
    };

    const writeToDest = (dest: unknown, data: Uint8Array): void => {
      if (!dest || typeof dest !== 'object') {
        return;
      }
      const writable = dest as { write?: (chunk: Uint8Array) => unknown };
      if (typeof writable.write === 'function') {
        writable.write(data);
      }
    };

    const endDest = (dest: unknown): void => {
      if (!dest || typeof dest !== 'object') {
        return;
      }
      const writable = dest as { end?: () => unknown };
      if (typeof writable.end === 'function') {
        writable.end();
      }
    };

    const errorDest = (dest: unknown, error: unknown): void => {
      if (!dest || typeof dest !== 'object') {
        return;
      }
      const emittable = dest as { emit?: (event: string, error: unknown) => unknown };
      if (typeof emittable.emit === 'function') {
        emittable.emit('error', error);
      }
    };

    const flush = (): void => {
      if (closed || paused || delivered || !cachedData) {
        return;
      }

      delivered = true;
      emit('data', cachedData);
      for (const target of pipeTargets) {
        writeToDest(target, cachedData);
      }

      ended = true;
      emit('end');
      for (const target of pipeTargets) {
        endDest(target);
      }

      if (!closed) {
        closed = true;
        emit('close');
      }
    };

    const removeListener = (event: string, cb: (...args: unknown[]) => void): void => {
      const eventListeners = listeners[event];
      if (!eventListeners) {
        return;
      }
      const index = eventListeners.indexOf(cb);
      if (index >= 0) {
        eventListeners.splice(index, 1);
      }
    };

    const pipeTargets: unknown[] = [];
    const start = (): void => {
      if (started) return;
      started = true;

      // Emit stream events asynchronously to mirror Node stream behavior.
      setTimeout(() => {
        if (closed) {
          return;
        }
        try {
          cachedData = self.readFileSync(path);
          opened = true;
          emit('open', 0);
          flush();
        } catch (err) {
          cachedError = err;
          emit('error', err);
          for (const target of pipeTargets) {
            errorDest(target, err);
          }
          if (!closed) {
            closed = true;
            emit('close');
          }
        }
      }, 0);
    };

    const stream = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);

        if (event === 'open' && opened) {
          setTimeout(() => cb(0), 0);
        } else if (event === 'data' && cachedData && delivered) {
          setTimeout(() => cb(cachedData), 0);
        } else if (event === 'end' && ended) {
          setTimeout(() => cb(), 0);
        } else if (event === 'error' && cachedError) {
          setTimeout(() => cb(cachedError), 0);
        } else if (event === 'close' && closed) {
          setTimeout(() => cb(), 0);
        }

        start();
        return stream;
      },
      once(event: string, cb: (...args: unknown[]) => void) {
        const wrapped = (...args: unknown[]) => {
          removeListener(event, wrapped);
          cb(...args);
        };
        stream.on(event, wrapped);
        return stream;
      },
      pipe(dest: unknown) {
        pipeTargets.push(dest);
        if (dest && typeof dest === 'object') {
          const emittable = dest as { emit?: (event: string, source: unknown) => void };
          if (typeof emittable.emit === 'function') {
            emittable.emit('pipe', stream);
          }
        }
        if (cachedData && delivered) {
          writeToDest(dest, cachedData);
          endDest(dest);
        } else if (cachedError) {
          errorDest(dest, cachedError);
        }
        flush();
        start();
        return dest;
      },
      pause() {
        paused = true;
        return stream;
      },
      resume() {
        paused = false;
        flush();
        start();
        return stream;
      },
      destroy(error?: unknown) {
        if (closed) {
          return stream;
        }
        if (error) {
          cachedError = error;
          emit('error', error);
        }
        closed = true;
        ended = true;
        emit('close');
        return stream;
      },
      emit,
    };

    return stream;
  }

  /**
   * Create write stream - simplified implementation
   */
  createWriteStream(path: string): {
    write: (data: string | Uint8Array) => boolean;
    end: (data?: string | Uint8Array) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  } {
    const self = this;
    const chunks: Uint8Array[] = [];
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const encoder = new TextEncoder();

    return {
      write(data: string | Uint8Array): boolean {
        const chunk = typeof data === 'string' ? encoder.encode(data) : data;
        chunks.push(chunk);
        return true;
      },
      end(data?: string | Uint8Array): void {
        if (data) {
          const chunk = typeof data === 'string' ? encoder.encode(data) : data;
          chunks.push(chunk);
        }
        // Combine chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        self.writeFileSync(path, combined);
        listeners['finish']?.forEach((cb) => cb());
        listeners['close']?.forEach((cb) => cb());
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
        return this;
      },
    };
  }
}
