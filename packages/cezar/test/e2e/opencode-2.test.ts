import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const enabled = process.env.CEZ_OPENCODE_V2_TEST === '1';
const binary = process.env.CEZ_OPENCODE_BIN ?? (process.platform === 'win32' ? 'opencode.exe' : 'opencode');
const timeoutMs = Number(process.env.CEZ_OPENCODE_TEST_TIMEOUT_MS ?? 120_000);

type JsonObject = Record<string, unknown>;

type HttpResult = {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
};

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function requestJson(
  url: string,
  password: string,
  method: string,
  body?: JsonObject,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(url, {
      method,
      headers: {
        authorization: basicAuth(password),
        accept: 'application/json',
        ...(payload === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }),
      },
    });
    request.once('error', reject);
    request.once('response', (response) => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function parseJson(result: HttpResult, label: string): JsonObject {
  assert.match(
    result.headers['content-type'] ?? '',
    /application\/json/i,
    `${label} should return JSON, got ${result.headers['content-type'] ?? 'no content type'}: ${result.body.slice(0, 300)}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${String(error)}; body=${result.body.slice(0, 300)}`);
  }
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} should return an object`);
  return parsed as JsonObject;
}

function dataEnvelope(result: HttpResult, label: string): JsonObject {
  const body = parseJson(result, label);
  assert.ok(body.data && typeof body.data === 'object' && !Array.isArray(body.data), `${label} should wrap an object in data`);
  return body.data as JsonObject;
}

function parseOptionalJson(result: HttpResult, label: string): void {
  if (result.body.trim() !== '') parseJson(result, label);
}

function childOutput(child: ChildProcessWithoutNullStreams): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return { stdout, stderr };
}

async function waitForServer(child: ChildProcessWithoutNullStreams, output: { stdout: string; stderr: string }): Promise<string> {
  const deadline = Date.now() + 30_000;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const match = output.stdout.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        resolve(match[0]);
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`OpenCode exited with ${child.exitCode}. stdout=${output.stdout} stderr=${output.stderr}`));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for OpenCode server. stdout=${output.stdout} stderr=${output.stderr}`));
        return;
      }
      setTimeout(check, 50).unref();
    };
    check();
  });
}

function openEvents(baseUrl: string, password: string): {
  frames: JsonObject[];
  connected: Promise<IncomingMessage>;
  closed: Promise<void>;
  close: () => void;
} {
  const frames: JsonObject[] = [];
  let response: IncomingMessage | undefined;
  let buffer = '';
  let resolveConnected!: (value: IncomingMessage) => void;
  let rejectConnected!: (error: Error) => void;
  let resolveClosed!: () => void;
  const connected = new Promise<IncomingMessage>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const request = httpRequest(`${baseUrl}/api/event`, {
    headers: {
      authorization: basicAuth(password),
      accept: 'text/event-stream',
    },
  });
  const close = (): void => {
    request.destroy();
    response?.destroy();
  };
  request.once('error', (error) => {
    if (!response) rejectConnected(error);
    resolveClosed();
  });
  request.once('response', (incoming) => {
    response = incoming;
    if ((incoming.statusCode ?? 0) < 200 || (incoming.statusCode ?? 0) >= 300) {
      rejectConnected(new Error(`SSE returned HTTP ${incoming.statusCode}`));
      incoming.resume();
      resolveClosed();
      return;
    }
    assert.match(incoming.headers['content-type'] ?? '', /text\/event-stream/i);
    resolveConnected(incoming);
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => {
      buffer += chunk;
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frames.push(parsed as JsonObject);
        } catch {
          // Ignore non-JSON SSE frames but keep the raw protocol connection alive.
        }
      }
    });
    incoming.once('close', resolveClosed);
    incoming.once('end', resolveClosed);
    incoming.once('error', resolveClosed);
  });
  request.end();
  return { frames, connected, closed, close };
}

function waitFor<T>(promise: Promise<T>, label: string, limit = timeoutMs): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${limit}ms`)), limit);
      timer.unref();
    }),
  ]);
}

async function runOpenCodeVersion(): Promise<string> {
  const result = await execFile(binary, ['--version'], { timeout: 30_000, maxBuffer: 1_000_000 });
  return `${result.stdout}\n${result.stderr}`.trim();
}

test(
  'OpenCode 2.x HTTP protocol: auth, envelopes, worktree binding, prompt, SSE idle, and interrupt',
  { skip: !enabled, timeout: timeoutMs + 30_000 },
  async () => {
    const version = await runOpenCodeVersion();
    assert.match(version, /(?:^|\D)2\./, `expected OpenCode 2.x, got: ${version}`);

    const root = await mkdtemp(join(tmpdir(), 'cezar-opencode-v2-'));
    const password = `cez-${Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url')}`;
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = childOutput(child);
    let events: ReturnType<typeof openEvents> | undefined;

    try {
      const baseUrl = await waitForServer(child, output);
      const probe = await requestJson(`${baseUrl}/api/session`, password, 'GET');
      assert.ok(probe.status >= 200 && probe.status < 300, `GET /api/session failed: HTTP ${probe.status} ${probe.body}`);
      const probeBody = parseJson(probe, 'GET /api/session');
      assert.ok(Array.isArray(probeBody.data), 'GET /api/session should return data[]');

      const created = await requestJson(
        `${baseUrl}/api/session?directory=${encodeURIComponent(root)}`,
        password,
        'POST',
        {},
      );
      assert.ok(created.status >= 200 && created.status < 300, `POST /api/session failed: HTTP ${created.status} ${created.body}`);
      const session = dataEnvelope(created, 'POST /api/session');
      const sessionId = session.id;
      assert.equal(typeof sessionId, 'string', 'session response data.id should be a string');
      const location = session.location;
      assert.ok(location && typeof location === 'object', 'session response should include location');
      assert.equal((location as JsonObject).directory, root, 'session must bind to the requested worktree');

      events = openEvents(baseUrl, password);
      await waitFor(events.connected, 'SSE connection');

      const prompt = await requestJson(
        `${baseUrl}/api/session/${encodeURIComponent(sessionId as string)}/prompt`,
        password,
        'POST',
        { text: 'Reply with exactly: CEZAR_OPENCODE_V2_OK' },
      );
      assert.ok(prompt.status >= 200 && prompt.status < 300, `POST /prompt failed: HTTP ${prompt.status} ${prompt.body}`);
      parseOptionalJson(prompt, 'POST /prompt');

      await waitFor(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (events?.frames.some((frame) => frame.type === 'session.idle' && (frame.data as JsonObject | undefined)?.sessionID === sessionId)) {
              resolve();
              return;
            }
            setTimeout(check, 50).unref();
          };
          check();
        }),
        'session.idle event',
      );

      const frameTypes = events.frames.map((frame) => frame.type).filter((type): type is string => typeof type === 'string');
      assert.ok(frameTypes.includes('server.connected'), `missing server.connected; received ${frameTypes.join(', ')}`);
      assert.ok(frameTypes.includes('session.idle'), `missing session.idle; received ${frameTypes.join(', ')}`);
      assert.ok(
        events.frames.some((frame) => frame.type === 'session.created' && (frame.data as JsonObject | undefined)?.sessionID === sessionId),
        `missing session.created for ${sessionId}; received ${frameTypes.join(', ')}`,
      );

      const interrupt = await requestJson(
        `${baseUrl}/api/session/${encodeURIComponent(sessionId as string)}/interrupt`,
        password,
        'POST',
        {},
      );
      assert.ok(interrupt.status >= 200 && interrupt.status < 300, `POST /interrupt failed: HTTP ${interrupt.status} ${interrupt.body}`);
      parseOptionalJson(interrupt, 'POST /interrupt');
    } finally {
      events?.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 5_000).unref();
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);
