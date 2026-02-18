import { describe, expect, it } from 'vitest';
import { redirectNpmImports } from '../src/frameworks/code-transforms';

describe('redirectNpmImports', () => {
  describe('framework-specific behavior', () => {
    it('pins Svelte subpath imports to a single runtime version', () => {
      const code = `
import * as client from 'svelte/internal/client';
import { mount } from 'svelte';
`;

      const transformed = redirectNpmImports(code);

      expect(transformed).toContain('https://esm.sh/svelte@5.39.6/internal/client');
      expect(transformed).toContain('https://esm.sh/svelte@5.39.6');
      expect(transformed).not.toContain('svelte/internal/client?external=react');
    });

    it('keeps solid-js imports as bare specifiers for import-map resolution', () => {
      const code = `
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import h from 'solid-js/h';
`;
      const transformed = redirectNpmImports(code);
      expect(transformed).toContain(`from 'solid-js/web'`);
      expect(transformed).toContain(`from 'solid-js'`);
      expect(transformed).toContain(`from 'solid-js/h'`);
      expect(transformed).not.toContain('https://esm.sh/solid-js');
    });

    it('keeps external=react behavior for generic npm packages', () => {
      const code = `import dayjs from 'dayjs';`;
      const transformed = redirectNpmImports(code);
      expect(transformed).toContain('https://esm.sh/dayjs?external=react');
    });
  });

  describe('version resolution from dependencies', () => {
    const deps = {
      ai: '^4.0.0',
      '@ai-sdk/openai': '^1.0.0',
      lodash: '~4.17.21',
      react: '^18.2.0',
    };

    it('includes major version for subpath imports', () => {
      const code = `import { useChat } from 'ai/react';`;
      const result = redirectNpmImports(code, undefined, deps);
      expect(result).toContain('esm.sh/ai@4/react');
    });

    it('includes major version for scoped package subpath imports', () => {
      const code = `import { createOpenAI } from '@ai-sdk/openai/server';`;
      const result = redirectNpmImports(code, undefined, deps);
      expect(result).toContain('esm.sh/@ai-sdk/openai@1/server');
    });

    it('includes major version for root package imports', () => {
      const code = `import _ from 'lodash';`;
      const result = redirectNpmImports(code, undefined, deps);
      expect(result).toContain('esm.sh/lodash@4');
    });

    it('works without dependencies (no version in URL)', () => {
      const code = `import { useChat } from 'ai/react';`;
      const result = redirectNpmImports(code);
      expect(result).toContain('esm.sh/ai/react');
      expect(result).not.toContain('@4');
    });

    it('does not add version for packages not in dependencies', () => {
      const code = `import something from 'unknown-pkg/sub';`;
      const result = redirectNpmImports(code, undefined, deps);
      expect(result).toContain('esm.sh/unknown-pkg/sub');
      expect(result).not.toMatch(/@\d/);
    });

    it('still uses explicit mappings for react', () => {
      const code = `import React from 'react';`;
      const result = redirectNpmImports(code, undefined, deps);
      expect(result).toContain('esm.sh/react@');
      expect(result).toContain('?dev');
    });

    it('handles semver range formats', () => {
      const testDeps = {
        'pkg-caret': '^3.1.0',
        'pkg-tilde': '~2.0.5',
        'pkg-exact': '1.2.3',
        'pkg-gte': '>=5.0.0',
      };

      expect(redirectNpmImports(`import x from 'pkg-caret/sub';`, undefined, testDeps))
        .toContain('esm.sh/pkg-caret@3/sub');
      expect(redirectNpmImports(`import x from 'pkg-tilde/sub';`, undefined, testDeps))
        .toContain('esm.sh/pkg-tilde@2/sub');
      expect(redirectNpmImports(`import x from 'pkg-exact/sub';`, undefined, testDeps))
        .toContain('esm.sh/pkg-exact@1/sub');
      expect(redirectNpmImports(`import x from 'pkg-gte/sub';`, undefined, testDeps))
        .toContain('esm.sh/pkg-gte@5/sub');
    });
  });

  describe('basic behavior (no dependencies)', () => {
    it('redirects bare imports to esm.sh', () => {
      const code = `import { something } from 'some-package';`;
      const result = redirectNpmImports(code);
      expect(result).toContain('esm.sh/some-package');
    });

    it('does not redirect relative imports', () => {
      const code = `import { foo } from './utils';`;
      const result = redirectNpmImports(code);
      expect(result).toBe(code);
    });

    it('does not redirect next/* imports (local packages)', () => {
      const code = `import Link from 'next/link';`;
      const result = redirectNpmImports(code);
      expect(result).toBe(code);
    });

    it('skips additional local packages', () => {
      const code = `import { api } from 'convex/_generated/api';`;
      const result = redirectNpmImports(code, ['convex/_generated/api']);
      expect(result).toBe(code);
    });
  });

  describe('installedPackages (VFS-served via /_npm/)', () => {
    const installed = new Set(['@ai-sdk/react', 'zod', 'ai']);

    it('redirects installed package to /_npm/', () => {
      const code = `import { useChat } from '@ai-sdk/react';`;
      const result = redirectNpmImports(code, undefined, undefined, undefined, installed);
      expect(result).toContain('/_npm/@ai-sdk/react');
      expect(result).not.toContain('esm.sh');
    });

    it('redirects installed package subpath to /_npm/', () => {
      const code = `import { z } from 'zod/v4';`;
      const result = redirectNpmImports(code, undefined, undefined, undefined, installed);
      expect(result).toContain('/_npm/zod/v4');
    });

    it('still uses explicit mapping for react (not /_npm/)', () => {
      const withReact = new Set(['react', '@ai-sdk/react']);
      const code = `import React from 'react';`;
      const result = redirectNpmImports(code, undefined, undefined, undefined, withReact);
      expect(result).toContain('esm.sh/react@');
      expect(result).not.toContain('/_npm/react');
    });

    it('falls through to esm.sh for non-installed packages', () => {
      const code = `import _ from 'lodash';`;
      const result = redirectNpmImports(code, undefined, undefined, undefined, installed);
      expect(result).toContain('esm.sh/lodash');
    });

    it('handles scoped package root import', () => {
      const code = `import ai from 'ai';`;
      const result = redirectNpmImports(code, undefined, undefined, undefined, installed);
      expect(result).toContain('/_npm/ai');
    });
  });
});
