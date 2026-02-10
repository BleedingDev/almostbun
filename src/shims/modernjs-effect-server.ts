/**
 * Minimal @modern-js/plugin-bff/effect-server shim.
 *
 * It implements just enough of Effect + HttpApiBuilder + OpenTelemetry glue to
 * execute compiled Modern.js BFF handlers inside almostnode.
 */

import type {
  EffectApi,
  EffectApiEndpoint,
  EffectApiGroup,
  SchemaNode,
} from './modernjs-effect-client';

type MaybePromise<T> = T | Promise<T>;

interface Some<T> {
  _tag: 'Some';
  value: T;
}

interface None {
  _tag: 'None';
}

type OptionValue<T> = Some<T> | None;

interface ParsedTraceContext {
  traceId: string;
  spanId: string;
}

interface RuntimeSpan {
  name: string;
  parentSpanContext?: {
    spanId: string;
  };
  spanContext: () => {
    traceId: string;
    spanId: string;
  };
}

interface SpanProcessor {
  onStart?: (span: RuntimeSpan) => void;
  onEnd?: (span: RuntimeSpan) => void;
  forceFlush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

interface EffectExecutionContext {
  currentSpan?: ParsedTraceContext;
  spanProcessor?: SpanProcessor;
}

interface EffectRouteHandlerContext {
  request: Request;
  headers: Record<string, string | undefined>;
  urlParams: Record<string, string | undefined>;
}

interface GroupLayer {
  kind: 'group';
  groupName: string;
  handlers: Record<string, (context: EffectRouteHandlerContext) => unknown>;
}

interface OTelLayer {
  kind: 'otel';
  spanProcessor?: SpanProcessor;
}

interface ProvideLayer {
  kind: 'provide';
  provided: GroupLayer | OTelLayer;
}

interface ApiLayer {
  api: EffectApi;
  groups: GroupLayer[];
  spanProcessor?: SpanProcessor;
  pipe: (...ops: Array<GroupLayer | OTelLayer | ProvideLayer>) => ApiLayer;
}

interface EffectBffDefinition {
  api: EffectApi;
  layer: ApiLayer;
}

export interface EffectBffRoute {
  method: 'GET' | 'POST';
  path: string;
  name: string;
  run: (request: Request) => Promise<unknown>;
}

export interface EffectBffRouter {
  routes: EffectBffRoute[];
  openapi: Record<string, unknown>;
  handle(method: string, path: string, request: Request): Promise<unknown>;
}

const EFFECT_BFF_TAG = Symbol.for('almostnode.modernjs.effect-bff');

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < bytes; i++) {
      out[i] = Math.floor(Math.random() * 256);
    }
  }

  let hex = '';
  for (let i = 0; i < out.length; i++) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function normalizeRoutePath(pathname: string): string {
  if (!pathname) {
    return '/';
  }

  if (pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

class SimpleEffect<T> {
  private readonly runImpl: (context: EffectExecutionContext) => Promise<T>;

  constructor(runImpl: (context: EffectExecutionContext) => Promise<T>) {
    this.runImpl = runImpl;
  }

  run(context: EffectExecutionContext): Promise<T> {
    return this.runImpl(context);
  }

  pipe(...ops: Array<(effect: SimpleEffect<T>) => SimpleEffect<T>>): SimpleEffect<T> {
    let next: SimpleEffect<T> = this;
    for (const op of ops) {
      next = op(next);
    }
    return next;
  }

  *[Symbol.iterator](): Generator<SimpleEffect<T>, T, T> {
    const result = (yield this) as T;
    return result;
  }
}

function isSimpleEffect(value: unknown): value is SimpleEffect<unknown> {
  return value instanceof SimpleEffect;
}

async function runMaybeEffect<T>(
  value: unknown,
  context: EffectExecutionContext
): Promise<T> {
  if (isSimpleEffect(value)) {
    return (await value.run(context)) as T;
  }

  return (await Promise.resolve(value)) as T;
}

export const Effect = {
  succeed<T>(value: T): SimpleEffect<T> {
    return new SimpleEffect(async () => value);
  },

  sync<T>(fn: () => T): SimpleEffect<T> {
    return new SimpleEffect(async () => fn());
  },

  promise<T>(fn: () => MaybePromise<T>): SimpleEffect<T> {
    return new SimpleEffect(async () => await fn());
  },

  dieMessage(message: string): SimpleEffect<never> {
    return new SimpleEffect(async () => {
      throw new Error(message);
    });
  },

  gen<T>(fn: () => Generator<unknown, T, unknown>): SimpleEffect<T> {
    return new SimpleEffect(async (context) => {
      const iterator = fn();
      let next: IteratorResult<unknown, T>;
      let input: unknown = undefined;

      while (true) {
        try {
          next = iterator.next(input);
        } catch (error) {
          throw error;
        }

        if (next.done) {
          return next.value;
        }

        try {
          input = await runMaybeEffect(next.value, context);
        } catch (error) {
          if (typeof iterator.throw === 'function') {
            next = iterator.throw(error) as IteratorResult<unknown, T>;
            if (next.done) {
              return next.value;
            }
            input = await runMaybeEffect(next.value, context);
          } else {
            throw error;
          }
        }
      }
    });
  },

  withSpan(
    name: string,
    options?: {
      parent?: ParsedTraceContext;
      kind?: string;
      attributes?: Record<string, unknown>;
    }
  ) {
    return <T>(effect: SimpleEffect<T>): SimpleEffect<T> => {
      return new SimpleEffect(async (context) => {
        const parent = options?.parent || context.currentSpan;
        const spanContext: ParsedTraceContext = {
          traceId: parent?.traceId || randomHex(16),
          spanId: randomHex(8),
        };

        const span: RuntimeSpan = {
          name,
          parentSpanContext: parent ? { spanId: parent.spanId } : undefined,
          spanContext: () => ({
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
          }),
        };

        context.spanProcessor?.onStart?.(span);

        const nextContext: EffectExecutionContext = {
          ...context,
          currentSpan: spanContext,
        };

        try {
          return await effect.run(nextContext);
        } finally {
          context.spanProcessor?.onEnd?.(span);
        }
      });
    };
  },
};

export const Option = {
  none<T = never>(): OptionValue<T> {
    return { _tag: 'None' };
  },

  some<T>(value: T): OptionValue<T> {
    return { _tag: 'Some', value };
  },

  getOrUndefined<T>(value: OptionValue<T>): T | undefined {
    return value._tag === 'Some' ? value.value : undefined;
  },

  match<T, R>(
    value: OptionValue<T>,
    handlers: {
      onNone: () => R;
      onSome: (value: T) => R;
    }
  ): R {
    return value._tag === 'Some'
      ? handlers.onSome(value.value)
      : handlers.onNone();
  },
};

export const HttpTraceContext = {
  w3c(headers: Headers): OptionValue<ParsedTraceContext> {
    const traceparent = headers.get('traceparent');
    if (!traceparent) {
      return Option.none();
    }

    const match = traceparent.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i);
    if (!match) {
      return Option.none();
    }

    return Option.some({
      traceId: match[1].toLowerCase(),
      spanId: match[2].toLowerCase(),
    });
  },
};

class ApiLayerImpl implements ApiLayer {
  api: EffectApi;
  groups: GroupLayer[] = [];
  spanProcessor?: SpanProcessor;

  constructor(api: EffectApi) {
    this.api = api;
  }

  pipe(...ops: Array<GroupLayer | OTelLayer | ProvideLayer>): ApiLayer {
    for (const op of ops) {
      const provided = (op as ProvideLayer).kind === 'provide'
        ? (op as ProvideLayer).provided
        : op;

      if ((provided as GroupLayer).kind === 'group') {
        this.groups.push(provided as GroupLayer);
      }

      if ((provided as OTelLayer).kind === 'otel') {
        this.spanProcessor = (provided as OTelLayer).spanProcessor;
      }
    }

    return this;
  }
}

export const HttpApiBuilder = {
  group(
    _api: EffectApi,
    groupName: string,
    setup: (handlers: {
      handle: (
        endpointName: string,
        handler: (context: EffectRouteHandlerContext) => unknown
      ) => {
        handle: (
          endpointName: string,
          handler: (context: EffectRouteHandlerContext) => unknown
        ) => unknown;
      };
    }) => unknown
  ): GroupLayer {
    const handlers: Record<string, (context: EffectRouteHandlerContext) => unknown> = {};

    const builder = {
      handle(
        endpointName: string,
        handler: (context: EffectRouteHandlerContext) => unknown
      ) {
        handlers[endpointName] = handler;
        return builder;
      },
    };

    setup(builder);

    return {
      kind: 'group',
      groupName,
      handlers,
    };
  },

  api(api: EffectApi): ApiLayer {
    return new ApiLayerImpl(api);
  },
};

export const Layer = {
  provide(provided: GroupLayer | OTelLayer): ProvideLayer {
    return {
      kind: 'provide',
      provided,
    };
  },
};

export const OpenTelemetry = {
  NodeSdk: {
    layer(factory: () => { spanProcessor?: SpanProcessor }): OTelLayer {
      const config = factory();
      return {
        kind: 'otel',
        spanProcessor: config?.spanProcessor,
      };
    },
  },
};

export function defineEffectBff(definition: EffectBffDefinition): EffectBffDefinition & {
  [EFFECT_BFF_TAG]: true;
} {
  return {
    ...definition,
    [EFFECT_BFF_TAG]: true,
  };
}

function getSchemaStructKeys(schema: SchemaNode | undefined): string[] {
  if (!schema || schema.kind !== 'struct') {
    return [];
  }

  return Object.keys(schema.shape);
}

function unwrapOptionalSchemaNode(schema: SchemaNode): {
  schema: SchemaNode;
  optional: boolean;
} {
  if (schema.kind === 'optional') {
    return {
      schema: schema.value,
      optional: true,
    };
  }

  return {
    schema,
    optional: false,
  };
}

function schemaNodeToOpenApiSchema(schema: SchemaNode | undefined): Record<string, unknown> {
  if (!schema) {
    return {};
  }

  if (schema.kind === 'optional') {
    return schemaNodeToOpenApiSchema(schema.value);
  }

  switch (schema.kind) {
    case 'string':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'literal': {
      const values = schema.values.slice();
      if (values.every(value => typeof value === 'string')) {
        return { type: 'string', enum: values };
      }
      if (values.every(value => typeof value === 'number')) {
        return { type: 'number', enum: values };
      }
      if (values.every(value => typeof value === 'boolean')) {
        return { type: 'boolean', enum: values };
      }
      return { enum: values };
    }
    case 'array':
      return {
        type: 'array',
        items: schemaNodeToOpenApiSchema(schema.value),
      };
    case 'struct': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(schema.shape)) {
        const normalized = unwrapOptionalSchemaNode(value);
        properties[key] = schemaNodeToOpenApiSchema(normalized.schema);
        if (!normalized.optional) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        ...(required.length > 0 ? { required } : {}),
        properties,
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}

function schemaNodeToOpenApiParameters(
  schema: SchemaNode | undefined,
  location: 'header' | 'query'
): Array<Record<string, unknown>> {
  if (!schema || schema.kind !== 'struct') {
    return [];
  }

  const out: Array<Record<string, unknown>> = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    const normalized = unwrapOptionalSchemaNode(value);
    out.push({
      name: key,
      in: location,
      required: !normalized.optional,
      schema: schemaNodeToOpenApiSchema(normalized.schema),
    });
  }

  return out;
}

function createDecodeErrorComponents(): Record<string, unknown> {
  return {
    HttpApiDecodeError: {
      type: 'object',
      required: ['issues', 'message', '_tag'],
      properties: {
        issues: {
          type: 'array',
          items: {
            $ref: '#/components/schemas/Issue',
          },
        },
        message: {
          type: 'string',
        },
        _tag: {
          type: 'string',
          enum: ['HttpApiDecodeError'],
        },
      },
      additionalProperties: false,
      description: 'The request did not match the expected schema',
    },
    Issue: {
      type: 'object',
      required: ['_tag', 'path', 'message'],
      properties: {
        _tag: {
          type: 'string',
          enum: [
            'Pointer',
            'Unexpected',
            'Missing',
            'Composite',
            'Refinement',
            'Transformation',
            'Type',
            'Forbidden',
          ],
          description: 'The tag identifying the type of parse issue',
        },
        path: {
          type: 'array',
          items: {
            $ref: '#/components/schemas/PropertyKey',
          },
          description: 'The path to the property where the issue occurred',
        },
        message: {
          type: 'string',
          description: 'A descriptive message explaining the issue',
        },
      },
      additionalProperties: false,
      description: 'Represents an error encountered while parsing a value to match the schema',
    },
    PropertyKey: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        {
          type: 'object',
          required: ['_tag', 'key'],
          properties: {
            _tag: {
              type: 'string',
              enum: ['symbol'],
            },
            key: {
              type: 'string',
            },
          },
          additionalProperties: false,
          description: 'an object to be decoded into a globally shared symbol',
        },
      ],
    },
  };
}

function buildOpenApiPaths(api: EffectApi): Record<string, Record<string, Record<string, unknown>>> {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const group of api.groups) {
    for (const endpoint of group.endpoints) {
      const normalized = normalizeRoutePath(endpoint.path);
      const method = endpoint.method.toLowerCase();
      const parameters = [
        ...schemaNodeToOpenApiParameters(endpoint.headersSchema, 'header'),
        ...schemaNodeToOpenApiParameters(endpoint.urlParamsSchema, 'query'),
      ];

      const responses: Record<string, unknown> = {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: schemaNodeToOpenApiSchema(endpoint.successSchema),
            },
          },
        },
        '400': {
          description: 'The request did not match the expected schema',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/HttpApiDecodeError',
              },
            },
          },
        },
      };

      paths[normalized] = paths[normalized] || {};
      paths[normalized][method] = {
        tags: [group.name],
        operationId: `${group.name}.${endpoint.name}`,
        parameters,
        security: [],
        responses,
      };
    }
  }

  return paths;
}

function buildOpenApiDocument(api: EffectApi): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Api',
      version: '0.0.1',
    },
    paths: buildOpenApiPaths(api),
    components: {
      schemas: createDecodeErrorComponents(),
      securitySchemes: {},
    },
    security: [],
    tags: api.groups.map(group => ({ name: group.name })),
  };
}

function createHeadersRecord(request: Request, schema?: SchemaNode): Record<string, string | undefined> {
  const keys = getSchemaStructKeys(schema);
  const headers: Record<string, string | undefined> = {};

  if (keys.length === 0) {
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }

  for (const key of keys) {
    headers[key] = request.headers.get(key) ?? undefined;
  }

  return headers;
}

function createUrlParamsRecord(request: Request, schema?: SchemaNode): Record<string, string | undefined> {
  const keys = getSchemaStructKeys(schema);
  const params: Record<string, string | undefined> = {};
  const url = new URL(request.url);

  if (keys.length === 0) {
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }

  for (const key of keys) {
    params[key] = url.searchParams.get(key) ?? undefined;
  }

  return params;
}

export function createEffectBffRouter(value: unknown): EffectBffRouter | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const definition = value as EffectBffDefinition & {
    [EFFECT_BFF_TAG]?: true;
  };

  if (!definition[EFFECT_BFF_TAG] || !definition.api || !definition.layer) {
    return null;
  }

  const groupLayerMap = new Map<string, GroupLayer>();
  for (const group of definition.layer.groups || []) {
    groupLayerMap.set(group.groupName, group);
  }

  const spanProcessor = definition.layer.spanProcessor;
  const routes: EffectBffRoute[] = [];

  for (const apiGroup of definition.api.groups || []) {
    const layerGroup = groupLayerMap.get(apiGroup.name);
    if (!layerGroup) {
      continue;
    }

    for (const endpoint of apiGroup.endpoints || []) {
      const handler = layerGroup.handlers[endpoint.name];
      if (!handler) {
        continue;
      }

      routes.push({
        method: endpoint.method,
        path: normalizeRoutePath(endpoint.path),
        name: endpoint.name,
        run: async (request: Request) => {
          const context: EffectRouteHandlerContext = {
            request,
            headers: createHeadersRecord(request, endpoint.headersSchema),
            urlParams: createUrlParamsRecord(request, endpoint.urlParamsSchema),
          };

          const value = handler(context);
          return await runMaybeEffect(value, {
            spanProcessor,
          });
        },
      });
    }
  }

  const openapi = buildOpenApiDocument(definition.api);

  return {
    routes,
    openapi,
    async handle(method: string, path: string, request: Request): Promise<unknown> {
      const normalizedMethod = method.toUpperCase();
      const normalizedPath = normalizeRoutePath(path);

      const route = routes.find(item =>
        item.method.toUpperCase() === normalizedMethod && item.path === normalizedPath
      );

      if (!route) {
        throw new Error(`No effect route for ${normalizedMethod} ${normalizedPath}`);
      }

      return await route.run(request);
    },
  };
}

export function isEffectBff(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Boolean((value as Record<symbol, unknown>)[EFFECT_BFF_TAG]);
}

export type {
  EffectApi,
  EffectApiEndpoint,
  EffectApiGroup,
} from './modernjs-effect-client';
