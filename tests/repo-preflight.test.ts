import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { runRepoPreflight } from '../src/repo/preflight';

describe('repo preflight', () => {
  it('detects unresolved workspace dependencies and applies install override auto-fix', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'workspace-app',
        dependencies: {
          '@demo/shared': 'workspace:*',
        },
      })
    );

    const result = runRepoPreflight(vfs, '/project', {
      autoFix: true,
      preferPublishedWorkspacePackages: undefined,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.issues.some(issue => issue.code === 'preflight.workspace.root-missing')).toBe(true);
    expect(result.installOverrides.preferPublishedWorkspacePackages).toBe(true);
    expect(result.installOverrides.includeWorkspaces).toBe(true);
  });

  it('reports missing @modern-js/plugin-bff for effect subpath imports', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'effect-app',
        dependencies: {
          react: '^18.0.0',
        },
      })
    );
    vfs.writeFileSync(
      '/project/src/index.ts',
      `import server from '@modern-js/plugin-bff/effect-server';\nexport default server;`
    );

    const result = runRepoPreflight(vfs, '/project');
    expect(result.hasErrors).toBe(true);
    expect(result.issues.some(issue => issue.code === 'preflight.modernjs.effect.missing-plugin-bff')).toBe(true);
  });

  it('warns when imported package subpaths are not exported', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'subpath-app',
        dependencies: {
          'limited-pkg': '1.0.0',
        },
      })
    );
    vfs.writeFileSync('/project/src/app.ts', `import value from 'limited-pkg/internal';\nexport default value;`);
    vfs.writeFileSync(
      '/project/node_modules/limited-pkg/package.json',
      JSON.stringify({
        name: 'limited-pkg',
        exports: {
          '.': './index.js',
        },
      })
    );
    vfs.writeFileSync('/project/node_modules/limited-pkg/index.js', 'module.exports = "ok";');

    const result = runRepoPreflight(vfs, '/project');
    expect(result.hasErrors).toBe(false);
    expect(
      result.issues.some(
        issue =>
          issue.code === 'preflight.exports.subpath-missing' &&
          issue.severity === 'warning'
      )
    ).toBe(true);
  });

  it('accepts wildcard exports for subpath imports', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'subpath-app',
        dependencies: {
          'wildcard-pkg': '1.0.0',
        },
      })
    );
    vfs.writeFileSync('/project/src/app.ts', `import value from 'wildcard-pkg/internal/test';\nexport default value;`);
    vfs.writeFileSync(
      '/project/node_modules/wildcard-pkg/package.json',
      JSON.stringify({
        name: 'wildcard-pkg',
        exports: {
          './*': './src/*.js',
        },
      })
    );
    vfs.writeFileSync('/project/node_modules/wildcard-pkg/src/internal/test.js', 'module.exports = "ok";');

    const result = runRepoPreflight(vfs, '/project');
    expect(result.issues.some(issue => issue.code === 'preflight.exports.subpath-missing')).toBe(false);
  });

  it('reports native package fallbacks when available', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'sqlite-app',
        dependencies: {
          sqlite3: '^5.1.7',
        },
      })
    );

    const result = runRepoPreflight(vfs, '/project');
    expect(
      result.issues.some(
        issue =>
          issue.code === 'preflight.native.fallback-available' &&
          issue.severity === 'info' &&
          issue.message.includes('sqlite3')
      )
    ).toBe(true);
  });

  it('warns for native packages without browser fallbacks', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'image-app',
        dependencies: {
          sharp: '^0.33.0',
        },
      })
    );

    const result = runRepoPreflight(vfs, '/project');
    expect(
      result.issues.some(
        issue =>
          issue.code === 'preflight.native.unsupported' &&
          issue.severity === 'warning' &&
          issue.message.includes('sharp')
      )
    ).toBe(true);
  });

  it('escalates security-sensitive warnings under strict security policy', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'image-app',
        dependencies: {
          sharp: '^0.33.0',
        },
      })
    );

    const result = runRepoPreflight(vfs, '/project', {
      securityPolicyPreset: 'strict',
      securityPolicyMode: 'enforce',
    });

    expect(
      result.issues.some(
        issue =>
          issue.code === 'preflight.native.unsupported' &&
          issue.severity === 'error'
      )
    ).toBe(true);
    expect(result.hasErrors).toBe(true);
    expect(result.policy?.preset).toBe('strict');
    expect((result.policy?.escalationCount || 0) > 0).toBe(true);
  });

  it('supports report-only security policy mode', () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/project/package.json',
      JSON.stringify({
        name: 'image-app',
        dependencies: {
          sharp: '^0.33.0',
        },
      })
    );

    const result = runRepoPreflight(vfs, '/project', {
      securityPolicyPreset: 'strict',
      securityPolicyMode: 'report-only',
    });

    expect(
      result.issues.some(
        issue =>
          issue.code === 'preflight.native.unsupported' &&
          issue.severity === 'error'
      )
    ).toBe(true);
    expect(result.hasErrors).toBe(false);
    expect((result.policy?.suppressedErrorCount || 0) > 0).toBe(true);
  });
});
