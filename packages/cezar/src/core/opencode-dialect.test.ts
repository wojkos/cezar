import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { detectOpencodeDialect, opencodeDialect } from './opencode-dialect.ts';

const AUTH = 'Basic dGVzdDpzZWNyZXQ=';

describe('opencode dialects', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('keeps v1 paths and prompt shape', () => {
    const dialect = opencodeDialect('v1');
    expect(dialect.sessionPath()).toBe('/session');
    expect(dialect.promptPath('ses/1')).toBe('/session/ses%2F1/message');
    expect(dialect.abortPath('ses/1')).toBe('/session/ses%2F1/abort');
    expect(dialect.eventPath()).toBe('/event');
    expect(dialect.promptBody('say hi')).toEqual({ parts: [{ type: 'text', text: 'say hi' }] });
    expect(dialect.postSettlesTurn).toBe(true);
  });

  it('normalizes v2 envelopes and frames at the boundary', () => {
    const dialect = opencodeDialect('v2');
    expect(dialect.sessionPath()).toBe('/api/session');
    expect(dialect.promptPath('ses/1')).toBe('/api/session/ses%2F1/prompt');
    expect(dialect.abortPath('ses/1')).toBe('/api/session/ses%2F1/interrupt');
    expect(dialect.eventPath()).toBe('/api/event');
    expect(dialect.promptBody('say hi')).toEqual({ text: 'say hi' });
    expect(dialect.unwrap({ data: { id: 'ses_1' } })).toEqual({ id: 'ses_1' });
    expect(
      dialect.normalizeFrame({ type: 'session.idle', data: { sessionID: 'ses_1' } }),
    ).toEqual({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(dialect.postSettlesTurn).toBe(false);
  });

  it('detects v2 from JSON content type, not status alone, and sends auth', async () => {
    let seenAuth = '';
    const base = await serve((request, response) => {
      seenAuth = String(request.headers.authorization ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });

    await expect(detectOpencodeDialect(base, AUTH)).resolves.toMatchObject({ version: 'v2' });
    expect(seenAuth).toBe(AUTH);
  });

  it('falls back to v1 for an SPA HTML catch-all', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html>');
    });

    await expect(detectOpencodeDialect(base, AUTH)).resolves.toMatchObject({ version: 'v1' });
  });
});
