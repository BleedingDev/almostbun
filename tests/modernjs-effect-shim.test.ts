import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { createEffectBffRouter } from '../src/shims/modernjs-effect-server';

function createApiModule(): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostEffectApi = void 0;
const effectClient = require("@modern-js/plugin-bff/effect-client");
exports.hostEffectApi = effectClient.HttpApi.make("HostEffectApi").add(
  effectClient.HttpApiGroup.make("greetings")
    .add(
      effectClient.HttpApiEndpoint.get("hello")\`/effect/hello\`.addSuccess(
        effectClient.Schema.Struct({
          message: effectClient.Schema.String,
          runtime: effectClient.Schema.Literal("host"),
        })
      )
    )
    .add(
      effectClient.HttpApiEndpoint.get("traceRun")\`/effect/trace/run\`
        .setHeaders(
          effectClient.Schema.Struct({
            traceparent: effectClient.Schema.optional(effectClient.Schema.String),
          })
        )
        .addSuccess(
          effectClient.Schema.Struct({
            status: effectClient.Schema.Literal("ok"),
            traceparent: effectClient.Schema.optional(effectClient.Schema.String),
          })
        )
    )
    .add(
      effectClient.HttpApiEndpoint.get("traceSpans")\`/effect/trace/spans\`
        .setUrlParams(
          effectClient.Schema.Struct({
            traceId: effectClient.Schema.optional(effectClient.Schema.String),
          })
        )
        .addSuccess(
          effectClient.Schema.Struct({
            spans: effectClient.Schema.Array(
              effectClient.Schema.Struct({
                name: effectClient.Schema.String,
                traceId: effectClient.Schema.String,
                spanId: effectClient.Schema.String,
              })
            ),
          })
        )
    )
);
`;
}

function createEffectHandlerModule(): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const effectServer = require("@modern-js/plugin-bff/effect-server");
const apiModule = require("../../shared/effect/api");

const spans = [];
const spanProcessor = {
  onStart() {},
  onEnd(span) {
    const ctx = span.spanContext();
    spans.push({
      name: span.name,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanContext ? span.parentSpanContext.spanId : undefined,
    });
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};

const groupLayer = effectServer.HttpApiBuilder.group(apiModule.hostEffectApi, "greetings", handlers => {
  const hello = handlers.handle("hello", () => effectServer.Effect.succeed({
    message: "Hello from host Effect API",
    runtime: "host",
  }));

  const trace = hello.handle("traceRun", ({ headers, request }) => {
    const parent = effectServer.Option.getOrUndefined(effectServer.HttpTraceContext.w3c(request.headers));
    return effectServer.Effect.gen(function* () {
      yield* effectServer.Effect.succeed("ok").pipe(
        effectServer.Effect.withSpan("mf.host.trace.child", { kind: "client" })
      );

      return {
        status: "ok",
        traceparent: headers.traceparent,
      };
    }).pipe(
      effectServer.Effect.withSpan("mf.host.trace.run", {
        parent,
        kind: "server",
      })
    );
  });

  return trace.handle("traceSpans", ({ urlParams }) =>
    effectServer.Effect.succeed({
      spans: typeof urlParams.traceId === "string"
        ? spans.filter(item => item.traceId === urlParams.traceId)
        : spans,
    })
  );
});

const layer = effectServer.HttpApiBuilder.api(apiModule.hostEffectApi).pipe(
  effectServer.Layer.provide(groupLayer),
  effectServer.Layer.provide(
    effectServer.OpenTelemetry.NodeSdk.layer(() => ({ spanProcessor }))
  )
);

exports.default = effectServer.defineEffectBff({
  api: apiModule.hostEffectApi,
  layer,
});
`;
}

describe('modernjs effect shims', () => {
  it('builds effect routes and openapi from compiled modules', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/shared/effect', { recursive: true });
    vfs.mkdirSync('/api/effect', { recursive: true });

    vfs.writeFileSync('/shared/effect/api.js', createApiModule());
    vfs.writeFileSync('/api/effect/index.js', createEffectHandlerModule());

    const runtime = new Runtime(vfs, { cwd: '/' });
    const mod = runtime.runFile('/api/effect/index.js').exports as { default?: unknown };

    const router = createEffectBffRouter(mod.default);
    expect(router).not.toBeNull();
    expect(router?.routes.length).toBe(3);
    const openapi = router!.openapi as {
      openapi?: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, Record<string, {
        operationId?: string;
        tags?: string[];
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
        responses?: Record<string, { description?: string }>;
      }>>;
      tags?: Array<{ name?: string }>;
      components?: { schemas?: Record<string, unknown> };
    };

    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi.info).toEqual({
      title: 'Api',
      version: '0.0.1',
    });
    expect(openapi.tags).toEqual([{ name: 'greetings' }]);
    expect(openapi.components?.schemas?.HttpApiDecodeError).toBeDefined();

    const helloOperation = openapi.paths?.['/effect/hello']?.get;
    expect(helloOperation?.operationId).toBe('greetings.hello');
    expect(helloOperation?.tags).toEqual(['greetings']);
    expect(helloOperation?.responses?.['200']?.description).toBe('Success');
    expect(helloOperation?.responses?.['400']?.description).toBe('The request did not match the expected schema');

    const traceRunOperation = openapi.paths?.['/effect/trace/run']?.get;
    expect(traceRunOperation?.parameters).toMatchObject([
      {
        name: 'traceparent',
        in: 'header',
        required: false,
      },
    ]);

    const traceSpansOperation = openapi.paths?.['/effect/trace/spans']?.get;
    expect(traceSpansOperation?.parameters).toMatchObject([
      {
        name: 'traceId',
        in: 'query',
        required: false,
      },
    ]);

    const hello = await router!.handle(
      'GET',
      '/effect/hello',
      new Request('http://localhost/effect/hello')
    );

    expect(hello).toEqual({
      message: 'Hello from host Effect API',
      runtime: 'host',
    });
  });

  it('propagates traceparent into generated span tree', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/shared/effect', { recursive: true });
    vfs.mkdirSync('/api/effect', { recursive: true });

    vfs.writeFileSync('/shared/effect/api.js', createApiModule());
    vfs.writeFileSync('/api/effect/index.js', createEffectHandlerModule());

    const runtime = new Runtime(vfs, { cwd: '/' });
    const mod = runtime.runFile('/api/effect/index.js').exports as { default?: unknown };
    const router = createEffectBffRouter(mod.default);

    expect(router).not.toBeNull();

    const traceId = '0123456789abcdef0123456789abcdef';
    const rootSpanId = '1111111111111111';

    await router!.handle(
      'GET',
      '/effect/trace/run',
      new Request('http://localhost/effect/trace/run', {
        headers: {
          traceparent: `00-${traceId}-${rootSpanId}-01`,
        },
      })
    );

    const spanResponse = await router!.handle(
      'GET',
      '/effect/trace/spans',
      new Request(`http://localhost/effect/trace/spans?traceId=${traceId}`)
    ) as { spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string }> };

    const runSpan = spanResponse.spans.find(item => item.name === 'mf.host.trace.run');
    const childSpan = spanResponse.spans.find(item => item.name === 'mf.host.trace.child');

    expect(runSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(runSpan?.traceId).toBe(traceId);
    expect(runSpan?.parentSpanId).toBe(rootSpanId);
    expect(childSpan?.traceId).toBe(traceId);
    expect(childSpan?.parentSpanId).toBe(runSpan?.spanId);
  });
});
