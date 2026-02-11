/**
 * worker_threads shim - browser-compatible message primitives
 */

import { EventEmitter } from './events';

export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;

const defer = (callback: () => void): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
};

type PortMessageRecord = {
  message: unknown;
};

export class MessagePort extends EventEmitter {
  private peer: MessagePort | null = null;
  private queue: PortMessageRecord[] = [];
  private closed = false;

  _connect(peer: MessagePort): void {
    this.peer = peer;
  }

  _enqueue(message: unknown): void {
    if (this.closed) return;
    const record: PortMessageRecord = { message };
    this.queue.push(record);
    defer(() => {
      const index = this.queue.indexOf(record);
      if (index === -1) {
        // Message was consumed via receiveMessageOnPort before event dispatch.
        return;
      }
      this.queue.splice(index, 1);
      this.emit('message', message);
    });
  }

  _dequeue(): PortMessageRecord | undefined {
    return this.queue.shift();
  }

  postMessage(value: unknown, _transferList?: unknown[]): void {
    if (this.closed || !this.peer) return;
    this.peer._enqueue(value);
  }

  start(): void {
    // No-op in compatibility mode.
  }

  close(): void {
    this.closed = true;
    this.peer = null;
  }

  ref(): void {}
  unref(): void {}
}

export class MessageChannel {
  port1 = new MessagePort();
  port2 = new MessagePort();

  constructor() {
    this.port1._connect(this.port2);
    this.port2._connect(this.port1);
  }
}

export class Worker extends EventEmitter {
  threadId: number;
  resourceLimits = {};
  private terminated = false;

  constructor(_filename: string, _options?: { workerData?: unknown }) {
    super();
    this.threadId = 0;
    console.warn('Worker threads run in single-threaded compatibility mode');
    defer(() => {
      this.emit('online');
    });
  }

  postMessage(value: unknown, _transferList?: unknown[]): void {
    if (this.terminated) return;
    // Compatibility mode: echo messages as if worker responded.
    defer(() => {
      if (!this.terminated) {
        this.emit('message', value);
      }
    });
  }

  terminate(): Promise<number> {
    this.terminated = true;
    defer(() => this.emit('exit', 0));
    return Promise.resolve(0);
  }

  ref(): void {}
  unref(): void {}

  getHeapSnapshot(): Promise<unknown> {
    return Promise.resolve({});
  }
}

const broadcastRegistry = new Map<string, Set<BroadcastChannel>>();

export class BroadcastChannel extends EventEmitter {
  name: string;
  private closed = false;

  constructor(name: string) {
    super();
    this.name = name;
    if (!broadcastRegistry.has(name)) {
      broadcastRegistry.set(name, new Set());
    }
    broadcastRegistry.get(name)!.add(this);
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    const listeners = broadcastRegistry.get(this.name);
    if (!listeners) return;
    for (const channel of listeners) {
      if (channel.closed) continue;
      defer(() => channel.emit('message', message));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = broadcastRegistry.get(this.name);
    listeners?.delete(this);
    if (listeners && listeners.size === 0) {
      broadcastRegistry.delete(this.name);
    }
  }

  ref(): void {}
  unref(): void {}
}

export function moveMessagePortToContext(
  port: MessagePort,
  _contextifiedSandbox: unknown
): MessagePort {
  return port;
}

export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined {
  return port._dequeue();
}

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

const environmentData = new Map<unknown, unknown>();

export function markAsUntransferable(_object: unknown): void {
  // No-op marker for compatibility.
}

export function getEnvironmentData(key: unknown): unknown {
  return environmentData.get(key);
}

export function setEnvironmentData(key: unknown, value: unknown): void {
  environmentData.set(key, value);
}

export default {
  isMainThread,
  parentPort,
  workerData,
  threadId,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  moveMessagePortToContext,
  receiveMessageOnPort,
  SHARE_ENV,
  markAsUntransferable,
  getEnvironmentData,
  setEnvironmentData,
};
