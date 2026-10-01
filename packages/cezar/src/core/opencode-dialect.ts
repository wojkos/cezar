import { opencodeRequest } from './opencode-http.ts';
import type { OpencodeResponse } from './opencode-http.ts';
import type { ModelIdentity } from './model-identity.ts';

export type OpencodeDialectVersion = 'v1' | 'v2';

export interface OpencodeDialect {
  readonly version: OpencodeDialectVersion;
  readonly postSettlesTurn: boolean;
  sessionPath(cwd: string): string;
  promptPath(id: string): string;
  abortPath(id: string): string;
  readonly eventPath: string;
  sessionBody(model: ModelIdentity | null): Record<string, unknown>;
  promptBody(text: string, model: ModelIdentity | null): Record<string, unknown>;
  unwrap(body: Record<string, unknown>): Record<string, unknown>;
  normalizeFrame(event: unknown): { type?: string; properties?: Record<string, unknown> };
}

const v1: OpencodeDialect = {
  version: 'v1',
  postSettlesTurn: true,
  sessionPath: () => '/session',
  promptPath: (id) => `/session/${encodeURIComponent(id)}/message`,
  abortPath: (id) => `/session/${encodeURIComponent(id)}/abort`,
  eventPath: '/event',
  sessionBody: () => ({ title: 'cezar task' }),
  promptBody: (text, model) => ({
    parts: [{ type: 'text', text }],
    ...(model ? { model: { providerID: model.provider, modelID: model.model } } : {}),
  }),
  unwrap: (body) => body,
  normalizeFrame: (event) => (isRecord(event) ? event : {}),
};

const v2: OpencodeDialect = {
  version: 'v2',
  postSettlesTurn: false,
  sessionPath: (cwd) => `/api/session?directory=${encodeURIComponent(cwd)}`,
  promptPath: (id) => `/api/session/${encodeURIComponent(id)}/prompt`,
  abortPath: (id) => `/api/session/${encodeURIComponent(id)}/interrupt`,
  eventPath: '/api/event',
  sessionBody: (model) => (model ? { model: { id: model.model, providerID: model.provider } } : {}),
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

/** A startup race: the "server listening" line can print a handful of ms
 *  before the listener actually accepts connections (observed directly
 *  against a real v2.0.20 build). A single failed probe must not condemn a
 *  genuine v2 server to a permanent, wrong v1 fallback. */
const DETECT_RETRIES = 5;
const DETECT_RETRY_DELAY_MS = 100;

/**
 * Detect the dialect before opening SSE.
 *
 * The test is content-type alone, never the status. v2's `/api/session`
 * answers JSON for every outcome, including an auth failure
 * (`401 application/json`) — and a wrong/late password must surface as a
 * clear v2 auth error later, not a silent, confusing fall-back to v1's
 * `POST /session → 405`. v1 has no `/api/session` route at all; v2's SPA
 * catch-all answers unmatched paths with `200 text/html`, which is the only
 * case that still reads as v1.
 */
export async function detectOpencodeDialect(baseUrl: string, authorization: string): Promise<OpencodeDialect> {
  let response: OpencodeResponse | undefined;
  for (let attempt = 0; attempt < DETECT_RETRIES; attempt++) {
    try {
      response = await opencodeRequest(`${baseUrl}/api/session`, { method: 'GET', authorization });
      break;
    } catch {
      if (attempt === DETECT_RETRIES - 1) return v1;
      await delay(DETECT_RETRY_DELAY_MS);
    }
  }
  if (!response) return v1;
  const contentType = response.headers['content-type'] ?? '';
  return /application\/json/i.test(contentType) ? v2 : v1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}
