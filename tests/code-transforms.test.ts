import { describe, expect, it } from 'vitest';
import { redirectNpmImports } from '../src/frameworks/code-transforms';

describe('redirectNpmImports', () => {
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

  it('keeps external=react behavior for generic npm packages', () => {
    const code = `import dayjs from 'dayjs';`;
    const transformed = redirectNpmImports(code);
    expect(transformed).toContain('https://esm.sh/dayjs?external=react');
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
});
