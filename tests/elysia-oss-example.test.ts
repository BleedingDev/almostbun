import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime';
import { PackageManager } from '../src/npm';
import { VirtualFS } from '../src/virtual-fs';

describe('Elysia OSS example compatibility (fresh-bun)', () => {
  it(
    'runs a featureful Elysia app with OpenAPI and typed routes',
    async () => {
      const vfs = new VirtualFS();
      vfs.writeFileSync('/project/package.json', JSON.stringify({ name: 'elysia-oss-example' }));

      const pm = new PackageManager(vfs, { cwd: '/project' });
      await pm.install('elysia');
      await pm.install('@elysiajs/openapi');
      await pm.install('@sinclair/typebox');
      await pm.install('openapi-types');

      const runtime = new Runtime(vfs, {
        cwd: '/project',
        env: { NODE_ENV: 'test' },
      });

      const { exports } = runtime.execute(
        `
        module.exports = (async () => {
          const { Elysia, t } = require('elysia');
          const { openapi } = require('@elysiajs/openapi');

          const app = new Elysia()
            .use(openapi({ path: '/api' }))
            .get(
              '/api/hello',
              ({ query }) => ({ message: 'hello from bun!', echo: query.message || null }),
              {
                query: t.Object({
                  message: t.Optional(t.String()),
                }),
              }
            )
            .post(
              '/api/hello',
              ({ body }) => ({ message: 'hello from bun!', echo: body.message }),
              {
                body: t.Object({
                  message: t.String(),
                }),
              }
            )
            .ws('/api/hello', {
              message(ws, payload) {
                ws.send(payload);
              },
              idleTimeout: 60,
            });

          const getRes = await app.handle(new Request('http://localhost/api/hello?message=from-get'));
          const postRes = await app.handle(new Request('http://localhost/api/hello', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'from-post' }),
          }));
          const specRes = await app.handle(new Request('http://localhost/api/json'));

          const getJson = await getRes.json();
          const postJson = await postRes.json();
          const specText = await specRes.text();

          return {
            getStatus: getRes.status,
            getJson,
            postStatus: postRes.status,
            postJson,
            specStatus: specRes.status,
            specHasOpenapi: specText.includes('"openapi"'),
            specHasHelloRoute: specText.includes('/api/hello'),
          };
        })();
        `,
        '/project/run-elysia-example.js'
      );

      const result = await exports;
      expect(result).toEqual({
        getStatus: 200,
        getJson: { message: 'hello from bun!', echo: 'from-get' },
        postStatus: 200,
        postJson: { message: 'hello from bun!', echo: 'from-post' },
        specStatus: 200,
        specHasOpenapi: true,
        specHasHelloRoute: true,
      });
    },
    300_000
  );
});
