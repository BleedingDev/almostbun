/**
 * Sandbox Helpers Tests
 */

import { describe, it, expect } from 'vitest';
import {
  getSandboxHtml,
  getSandboxVercelConfig,
  generateSandboxFiles,
  SANDBOX_SETUP_INSTRUCTIONS,
} from '../src/sandbox-helpers';

describe('Sandbox Helpers', () => {
  describe('getSandboxHtml', () => {
    it('should generate valid HTML', () => {
      const html = getSandboxHtml();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html>');
      expect(html).toContain('</html>');
    });

    it('should include just-node import from unpkg by default', () => {
      const html = getSandboxHtml();
      expect(html).toContain('https://unpkg.com/just-node/dist/index.js');
    });

    it('should use custom URL when provided', () => {
      const customUrl = 'https://cdn.example.com/just-node.js';
      const html = getSandboxHtml(customUrl);
      expect(html).toContain(customUrl);
      expect(html).not.toContain('unpkg.com');
    });

    it('should include VirtualFS and Runtime imports', () => {
      const html = getSandboxHtml();
      expect(html).toContain('VirtualFS');
      expect(html).toContain('Runtime');
    });

    it('should include message handler for postMessage communication', () => {
      const html = getSandboxHtml();
      expect(html).toContain("addEventListener('message'");
      expect(html).toContain("type: 'ready'");
      expect(html).toContain("case 'init'");
      expect(html).toContain("case 'execute'");
      expect(html).toContain("case 'runFile'");
    });

    it('should signal ready to parent on load', () => {
      const html = getSandboxHtml();
      expect(html).toContain("parent.postMessage({ type: 'ready' }");
    });
  });

  describe('getSandboxVercelConfig', () => {
    it('should return valid config object', () => {
      const config = getSandboxVercelConfig();
      expect(config).toHaveProperty('headers');
    });

    it('should include CORS headers', () => {
      const config = getSandboxVercelConfig() as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
      const headers = config.headers[0].headers;

      const corsHeader = headers.find(h => h.key === 'Access-Control-Allow-Origin');
      expect(corsHeader).toBeDefined();
      expect(corsHeader?.value).toBe('*');
    });

    it('should include Cross-Origin-Resource-Policy header', () => {
      const config = getSandboxVercelConfig() as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
      const headers = config.headers[0].headers;

      const corpHeader = headers.find(h => h.key === 'Cross-Origin-Resource-Policy');
      expect(corpHeader).toBeDefined();
      expect(corpHeader?.value).toBe('cross-origin');
    });
  });

  describe('generateSandboxFiles', () => {
    it('should generate index.html and vercel.json', () => {
      const files = generateSandboxFiles();
      expect(files).toHaveProperty('index.html');
      expect(files).toHaveProperty('vercel.json');
    });

    it('should generate valid HTML in index.html', () => {
      const files = generateSandboxFiles();
      expect(files['index.html']).toContain('<!DOCTYPE html>');
    });

    it('should generate valid JSON in vercel.json', () => {
      const files = generateSandboxFiles();
      expect(() => JSON.parse(files['vercel.json'])).not.toThrow();
    });

    it('should use custom URL in generated HTML', () => {
      const customUrl = 'https://my-cdn.com/just-node.js';
      const files = generateSandboxFiles(customUrl);
      expect(files['index.html']).toContain(customUrl);
    });
  });

  describe('SANDBOX_SETUP_INSTRUCTIONS', () => {
    it('should contain setup steps', () => {
      expect(SANDBOX_SETUP_INSTRUCTIONS).toContain('mkdir');
      expect(SANDBOX_SETUP_INSTRUCTIONS).toContain('vercel');
      expect(SANDBOX_SETUP_INSTRUCTIONS).toContain('createRuntime');
    });
  });
});
