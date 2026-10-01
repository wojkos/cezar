import { opencodeRequest } from './opencode-http.ts';
import type { OpencodeResponse } from './opencode-http.ts';

export type OpencodeDialectVersion = 'v1' | 'v2';

export interface OpencodeDialect {
  readonly version: OpencodeDialectVersion;
  readonly postSettlesTurn: boolean;
  sessionPath(): string;
  promptPath(id: string): string;
  abortPath(id: string): string;
  eventPath(): string;
  promptBody(text: string): Record<string, unknown>;
  unwrap(body: Record<string, unknown>): Record<string, unknown>;
  normalizeFrame(event: unknown): { type?: string; properties?: Record<string, unknown> };
}

const v1: OpencodeDialect = {
  version: 'v1',
  postSettlesTurn: true,
  sessionPath: () => '/session',
  promptPath: (id) => `/session/${encodeURIComponent(id)}/message`,
  abortPath: (id) => `/session/${encodeURIComponent(id)}/abort`,
  eventPath: () => '/event',
  promptBody: (text) => ({ parts: [{ type: 'text', text }] }),
  unwrap: (body) => body,
  normalizeFrame: (event) => (isRecord(event) ? event : {}),
};

const v2: OpencodeDialect = {
  version: 'v2',
  postSettlesTurn: false,
  sessionPath: () => '/api/session',
  promptPath: (id) => `/api/session/${encodeURIComponent(id)}/prompt`,
  abortPath: (id) => `/api/session/${encodeURIComponent(id)}/interrupt`,
  eventPath: () => '/api/event',
  promptBody: (text) => ({ text }),
  unwrap: (body) => (isRecord(body.data) ? body.data : {}),
  normalizeFrame: (event) => {
    if (!isRecord(event)) return {};
    const data = isRecord(event.data) ? event.data : {};
    return { type: stringField(event, 'type'), properties: data };
  },
};

export function opencodeDialect(version: OpencodeDialectVersion): OpencodeDialect {
  return version === 'v2' ? v2 : v1;
}

/** Detect the dialect before opening SSE: v2's SPA catch-all returns HTML 200. */
export async function detectOpencodeDialect(baseUrl: string, authorization: string): Promise<OpencodeDialect> {
  let response: OpencodeResponse;
  try {
    response = await opencodeRequest(`${baseUrl}/api/session`, { method: 'GET', authorization });
  } catch {
    return v1;
  }
  const contentType = response.headers['content-type'] ?? '';
  return response.status >= 200 && response.status < 300 && /application\/json/i.test(contentType)
    ? v2
    : v1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}
