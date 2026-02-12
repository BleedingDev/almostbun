import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerBridge, resetServerBridge, getServerBridge } from '../src/server-bridge';
import type { InitServiceWorkerOptions } from '../src/server-bridge';
import { createServer, setServerListenCallback, setServerCloseCallback } from '../src/shims/http';

describe('ServerBridge', () => {
  beforeEach(() => {
    resetServerBridge();
    setServerListenCallback(null);
    setServerCloseCallback(null);
  });

  afterEach(() => {
    resetServerBridge();
  });

  describe('initServiceWorker', () => {
    const originalNavigator = globalThis.navigator;

    afterEach(() => {
      // Restore original navigator
      if (originalNavigator !== undefined) {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          writable: true,
          configurable: true,
        });
      } else {
        delete (globalThis as any).navigator;
      }
    });

    it('should throw error when Service Workers not supported', async () => {
      // Mock navigator without serviceWorker property
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      });

      const bridge = new ServerBridge();
      await expect(bridge.initServiceWorker()).rejects.toThrow('Service Workers not supported');
    });

    it('should accept options parameter', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      });

      const bridge = new ServerBridge();
      const options: InitServiceWorkerOptions = {
        swUrl: '/custom/sw.js',
      };

      // Will throw because serviceWorker is not in navigator
      await expect(bridge.initServiceWorker(options)).rejects.toThrow('Service Workers not supported');
    });

    it('should accept undefined options', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      });

      const bridge = new ServerBridge();
      await expect(bridge.initServiceWorker(undefined)).rejects.toThrow('Service Workers not supported');
    });

    it('should accept empty options object', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      });

      const bridge = new ServerBridge();
      await expect(bridge.initServiceWorker({})).rejects.toThrow('Service Workers not supported');
    });
  });

  describe('initServiceWorker with mocked navigator', () => {
    const originalNavigator = globalThis.navigator;
    type GlobalWithOptionalMessageChannel = typeof globalThis & {
      MessageChannel?: typeof MessageChannel;
    };

    const withMockMessageChannel = async (run: () => Promise<void>) => {
      const globalWithMessageChannel = globalThis as GlobalWithOptionalMessageChannel;
      const originalMessageChannel = globalWithMessageChannel.MessageChannel;

      class MockMessageChannel {
        port1 = { onmessage: null as ((event: unknown) => void) | null, postMessage: vi.fn() };
        port2 = {};
      }

      globalWithMessageChannel.MessageChannel = MockMessageChannel as unknown as typeof MessageChannel;

      try {
        await run();
      } finally {
        if (originalMessageChannel === undefined) {
          Reflect.deleteProperty(globalThis as Record<string, unknown>, 'MessageChannel');
        } else {
          globalWithMessageChannel.MessageChannel = originalMessageChannel;
        }
      }
    };

    afterEach(() => {
      // Restore original navigator
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    });

    it('should use default swUrl when not specified', async () => {
      let registeredUrl: string | undefined;

      const mockServiceWorker = {
        controller: true, // SW already controls page
        addEventListener: vi.fn(),
        register: vi.fn().mockImplementation((url: string) => {
          registeredUrl = url;
          return Promise.resolve({
            active: { state: 'activated', addEventListener: vi.fn(), postMessage: vi.fn() },
            waiting: null,
            installing: null,
          });
        }),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { serviceWorker: mockServiceWorker },
        writable: true,
        configurable: true,
      });

      await withMockMessageChannel(async () => {
        const bridge = new ServerBridge();

        try {
          await bridge.initServiceWorker();
        } catch {
          // Ignore errors from incomplete mock
        }
      });

      expect(mockServiceWorker.register).toHaveBeenCalledWith('/__sw__.js', { scope: '/' });
      expect(registeredUrl).toBe('/__sw__.js');
    });

    it('should use custom swUrl when specified', async () => {
      let registeredUrl: string | undefined;

      const mockServiceWorker = {
        controller: true, // SW already controls page
        addEventListener: vi.fn(),
        register: vi.fn().mockImplementation((url: string) => {
          registeredUrl = url;
          return Promise.resolve({
            active: { state: 'activated', addEventListener: vi.fn(), postMessage: vi.fn() },
            waiting: null,
            installing: null,
          });
        }),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { serviceWorker: mockServiceWorker },
        writable: true,
        configurable: true,
      });

      await withMockMessageChannel(async () => {
        const bridge = new ServerBridge();

        try {
          await bridge.initServiceWorker({ swUrl: '/custom/path/__sw__.js' });
        } catch {
          // Ignore errors from incomplete mock
        }
      });

      expect(mockServiceWorker.register).toHaveBeenCalledWith('/custom/path/__sw__.js', { scope: '/' });
      expect(registeredUrl).toBe('/custom/path/__sw__.js');
    });

    it('should reuse existing active registration when already controlled', async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const active = {
        state: 'activated',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      };

      const registration = {
        active,
        waiting: null,
        installing: null,
        update,
      };

      const mockServiceWorker = {
        controller: {},
        addEventListener: vi.fn(),
        message: vi.fn(),
        register: vi.fn(),
        getRegistration: vi.fn().mockResolvedValue(registration),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { serviceWorker: mockServiceWorker },
        writable: true,
        configurable: true,
      });

      await withMockMessageChannel(async () => {
        const bridge = new ServerBridge();
        await bridge.initServiceWorker();
      });

      expect(mockServiceWorker.getRegistration).toHaveBeenCalledWith('/');
      expect(mockServiceWorker.register).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
    });

    it('should retry registration after unregistering stale registrations', async () => {
      const staleUnregister = vi.fn().mockResolvedValue(true);
      const active = {
        state: 'activated',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      };

      const mockServiceWorker = {
        controller: {},
        addEventListener: vi.fn(),
        register: vi.fn()
          .mockRejectedValueOnce(new Error('initial register failed'))
          .mockResolvedValueOnce({
            active,
            waiting: null,
            installing: null,
          }),
        getRegistration: vi.fn().mockResolvedValue(null),
        getRegistrations: vi.fn().mockResolvedValue([
          { unregister: staleUnregister },
        ]),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { serviceWorker: mockServiceWorker },
        writable: true,
        configurable: true,
      });

      await withMockMessageChannel(async () => {
        const bridge = new ServerBridge();
        await bridge.initServiceWorker();
      });

      expect(mockServiceWorker.register).toHaveBeenCalledTimes(2);
      expect(mockServiceWorker.register).toHaveBeenNthCalledWith(1, '/__sw__.js', { scope: '/' });
      expect(mockServiceWorker.register).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^\/__sw__\.js\?almostbun-sw-retry=\d+$/),
        { scope: '/' }
      );
      expect(mockServiceWorker.getRegistrations).toHaveBeenCalledTimes(1);
      expect(staleUnregister).toHaveBeenCalledTimes(1);
    });

    it('should fall back to /almostbun-sw.js when __sw__.js retries keep failing', async () => {
      const staleUnregister = vi.fn().mockResolvedValue(true);
      const active = {
        state: 'activated',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      };

      const mockServiceWorker = {
        controller: {},
        addEventListener: vi.fn(),
        register: vi.fn()
          .mockRejectedValueOnce(new Error('initial register failed'))
          .mockRejectedValueOnce(new Error('retry register failed'))
          .mockResolvedValueOnce({
            active,
            waiting: null,
            installing: null,
          }),
        getRegistration: vi.fn().mockResolvedValue(null),
        getRegistrations: vi.fn().mockResolvedValue([
          { unregister: staleUnregister },
        ]),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { serviceWorker: mockServiceWorker },
        writable: true,
        configurable: true,
      });

      await withMockMessageChannel(async () => {
        const bridge = new ServerBridge();
        await bridge.initServiceWorker();
      });

      expect(mockServiceWorker.register).toHaveBeenCalledTimes(3);
      expect(mockServiceWorker.register).toHaveBeenNthCalledWith(1, '/__sw__.js', { scope: '/' });
      expect(mockServiceWorker.register).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^\/__sw__\.js\?almostbun-sw-retry=\d+$/),
        { scope: '/' }
      );
      expect(mockServiceWorker.register).toHaveBeenNthCalledWith(
        3,
        expect.stringMatching(/^\/almostbun-sw\.js\?almostbun-sw-fallback=\d+$/),
        { scope: '/' }
      );
      expect(staleUnregister).toHaveBeenCalledTimes(1);
    });
  });

  describe('getServerBridge', () => {
    it('should return singleton instance', () => {
      const bridge1 = getServerBridge();
      const bridge2 = getServerBridge();
      expect(bridge1).toBe(bridge2);
    });

    it('should accept options on first call', () => {
      const bridge = getServerBridge({ baseUrl: 'http://example.com' });
      expect(bridge.getServerUrl(3000)).toBe('http://example.com/__virtual__/3000');
    });
  });

  describe('server registration', () => {
    it('should register and unregister servers', () => {
      const bridge = new ServerBridge();
      const server = createServer((req, res) => res.end('OK'));

      bridge.registerServer(server, 3000);
      expect(bridge.getServerPorts()).toContain(3000);

      bridge.unregisterServer(3000);
      expect(bridge.getServerPorts()).not.toContain(3000);
    });
  });
});
