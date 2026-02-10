/**
 * Minimal @modern-js/plugin-bff/effect-client shim.
 *
 * This captures API metadata (groups/endpoints/schemas) used by
 * compiled Modern.js BFF bundles so they can run in almostnode.
 */

export type SchemaNode =
  | { kind: 'string' }
  | { kind: 'boolean' }
  | { kind: 'literal'; values: unknown[] }
  | { kind: 'optional'; value: SchemaNode }
  | { kind: 'array'; value: SchemaNode }
  | { kind: 'struct'; shape: Record<string, SchemaNode> };

export const Schema = {
  String: { kind: 'string' } as SchemaNode,
  Boolean: { kind: 'boolean' } as SchemaNode,
  Literal(...values: unknown[]): SchemaNode {
    return { kind: 'literal', values };
  },
  optional(value: SchemaNode): SchemaNode {
    return { kind: 'optional', value };
  },
  Array(value: SchemaNode): SchemaNode {
    return { kind: 'array', value };
  },
  Struct(shape: Record<string, SchemaNode>): SchemaNode {
    return { kind: 'struct', shape };
  },
};

export interface EffectApiEndpoint {
  method: 'GET' | 'POST';
  name: string;
  path: string;
  successSchema?: SchemaNode;
  headersSchema?: SchemaNode;
  urlParamsSchema?: SchemaNode;
  addSuccess(schema: SchemaNode): EffectApiEndpoint;
  setHeaders(schema: SchemaNode): EffectApiEndpoint;
  setUrlParams(schema: SchemaNode): EffectApiEndpoint;
}

export interface EffectApiGroup {
  name: string;
  endpoints: EffectApiEndpoint[];
  add(endpoint: EffectApiEndpoint): EffectApiGroup;
}

export interface EffectApi {
  name: string;
  groups: EffectApiGroup[];
  add(group: EffectApiGroup): EffectApi;
}

function createEndpoint(
  method: 'GET' | 'POST',
  name: string,
  path: string
): EffectApiEndpoint {
  const endpoint: EffectApiEndpoint = {
    method,
    name,
    path,
    addSuccess(schema: SchemaNode): EffectApiEndpoint {
      endpoint.successSchema = schema;
      return endpoint;
    },
    setHeaders(schema: SchemaNode): EffectApiEndpoint {
      endpoint.headersSchema = schema;
      return endpoint;
    },
    setUrlParams(schema: SchemaNode): EffectApiEndpoint {
      endpoint.urlParamsSchema = schema;
      return endpoint;
    },
  };

  return endpoint;
}

function createTaggedEndpointFactory(method: 'GET' | 'POST', name: string) {
  return (strings: TemplateStringsArray, ...values: unknown[]): EffectApiEndpoint => {
    // Modern.js emits static paths, but we still join template values defensively.
    let path = strings[0] || '';
    for (let i = 0; i < values.length; i++) {
      path += String(values[i]) + (strings[i + 1] || '');
    }

    return createEndpoint(method, name, path);
  };
}

export const HttpApiEndpoint = {
  get(name: string) {
    return createTaggedEndpointFactory('GET', name);
  },
  post(name: string) {
    return createTaggedEndpointFactory('POST', name);
  },
};

export const HttpApiGroup = {
  make(name: string): EffectApiGroup {
    const group: EffectApiGroup = {
      name,
      endpoints: [],
      add(endpoint: EffectApiEndpoint): EffectApiGroup {
        group.endpoints.push(endpoint);
        return group;
      },
    };

    return group;
  },
};

export const HttpApi = {
  make(name: string): EffectApi {
    const api: EffectApi = {
      name,
      groups: [],
      add(group: EffectApiGroup): EffectApi {
        api.groups.push(group);
        return api;
      },
    };

    return api;
  },
};
