import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { detectRunnableProject, startDetectedProject } from '../src/repo/runner';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';

const DEFAULT_FIXTURE_ROOT =
  '/Users/satan/side/experiments/modernjs/tests/integration/routes-tanstack-mf';
const fixtureRoot = process.env.MODERNJS_MF_FIXTURE_ROOT || DEFAULT_FIXTURE_ROOT;
const hasFixture = fs.existsSync(fixtureRoot);

function copyRealPathToVfs(vfs: VirtualFS, srcPath: string, destPath: string): void {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    vfs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath)) {
      copyRealPathToVfs(
        vfs,
        path.join(srcPath, entry),
        path.posix.join(destPath, entry)
      );
    }
    return;
  }

  const content = fs.readFileSync(srcPath);
  vfs.mkdirSync(path.posix.dirname(destPath), { recursive: true });
  vfs.writeFileSync(destPath, content);
}

function findFirstFileContaining(
  vfs: VirtualFS,
  rootDir: string,
  matcher: (content: string, filePath: string) => boolean
): string | null {
  const visit = (dir: string): string | null => {
    for (const entry of vfs.readdirSync(dir)) {
      const absolute = path.posix.join(dir, entry);
      const stat = vfs.statSync(absolute);
      if (stat.isDirectory()) {
        const nested = visit(absolute);
        if (nested) return nested;
        continue;
      }
      if (!absolute.endsWith('.js')) {
        continue;
      }
      const content = vfs.readFileSync(absolute, 'utf8');
      if (matcher(content, absolute)) {
        return absolute;
      }
    }
    return null;
  };

  return visit(rootDir);
}

describe.skipIf(!hasFixture)('repo runner Modern.js local fixture integration', () => {
  afterEach(() => {
    resetServerBridge();
  });

  it('serves real MF host and auto-starts sibling remotes', async () => {
    const vfs = new VirtualFS();
    const targetBase = '/project/routes-tanstack-mf';

    for (const app of ['mf-host', 'mf-remote', 'mf-remote-2']) {
      const sourceBase = path.join(fixtureRoot, app);
      copyRealPathToVfs(
        vfs,
        path.join(sourceBase, 'modern.config.ts'),
        path.posix.join(targetBase, app, 'modern.config.ts')
      );
      copyRealPathToVfs(
        vfs,
        path.join(sourceBase, 'dist'),
        path.posix.join(targetBase, app, 'dist')
      );
    }

    const detected = detectRunnableProject(vfs, {
      projectPath: '/project/routes-tanstack-mf/mf-host',
    });

    expect(detected.kind).toBe('modernjs-dist');

    const running = await startDetectedProject(vfs, detected, {
      initServiceWorker: false,
      port: 3011,
    });

    const bridge = getServerBridge();

    const hostResponse = await bridge.handleRequest(
      3011,
      'GET',
      '/mf',
      {
        host: 'localhost',
        accept: 'text/html',
      }
    );

    expect(hostResponse.statusCode).toBe(200);

    const hostScriptWithRemotes = findFirstFileContaining(
      vfs,
      '/project/routes-tanstack-mf/mf-host/dist/static/js',
      content => content.includes('localhost:3010/mf-manifest.json') && content.includes('localhost:3012/mf-manifest.json')
    );

    expect(hostScriptWithRemotes).toBeTruthy();

    if (hostScriptWithRemotes) {
      const requestPath = hostScriptWithRemotes.replace('/project/routes-tanstack-mf/mf-host/dist', '');
      const hostScriptResponse = await bridge.handleRequest(
        3011,
        'GET',
        requestPath,
        {
          host: 'localhost',
          accept: 'application/javascript',
        }
      );

      const body = hostScriptResponse.body.toString();
      expect(hostScriptResponse.statusCode).toBe(200);
      expect(body).toContain('/__virtual__/3010/mf-manifest.json');
      expect(body).toContain('/__virtual__/3012/mf-manifest.json');
    }

    const remoteOneManifest = await bridge.handleRequest(
      3010,
      'GET',
      '/mf-manifest.json',
      {
        host: 'localhost',
        accept: 'application/json',
      }
    );

    expect(remoteOneManifest.statusCode).toBe(200);
    expect(JSON.parse(remoteOneManifest.body.toString())).toMatchObject({
      metaData: {
        publicPath: '/__virtual__/3010/',
      },
    });

    const remoteTwoManifest = await bridge.handleRequest(
      3012,
      'GET',
      '/mf-manifest.json',
      {
        host: 'localhost',
        accept: 'application/json',
      }
    );

    expect(remoteTwoManifest.statusCode).toBe(200);
    expect(JSON.parse(remoteTwoManifest.body.toString())).toMatchObject({
      metaData: {
        publicPath: '/__virtual__/3012/',
      },
    });

    running.stop();
  });
});
