import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const OPENCODE_BASE = 'https://opencode.ai/inference/go/v1';
const ROUTE = 'opencode-go-extra';

/** A minimal Cordis-like context that records the request-header listener. */
function makeContext() {
  const listeners = [];
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'llm-pi-ai/request-headers');
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    effect(install) {
      this.dispose = install();
    },
    logger: () => ({ debug() {} }),
  };
  return { ctx, listeners };
}

/** Install the plugin over a mock context with the given row config. */
function install(raw = {}) {
  const { ctx, listeners } = makeContext();
  apply(ctx, { providers: [ROUTE], ...raw });
  return { ctx, listeners };
}

/** Invoke a plugin's waterfall listener once. */
function run(listener, request, headers = new Headers(), next = () => headers) {
  assert.equal(typeof listener, 'function');
  return listener(request, headers, next);
}

/** Drive one request through an installed listener. */
function request(listener, sessionId, baseURL = OPENCODE_BASE, provider = ROUTE) {
  return run(listener, { provider, sessionId, baseURL });
}

function assertConfigError(raw, field) {
  assert.throws(
    () => apply(makeContext().ctx, { providers: [ROUTE], ...raw }),
    (error) => error instanceof TypeError && error.message.includes(`"${field}`),
  );
}

test('adds a per-session header on the configured provider and endpoint', () => {
  const { listeners } = install();
  const out = request(listeners[0], 'session-A');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-A');
});

test('passes other providers through unchanged and calls next exactly once', () => {
  const { listeners } = install();
  const headers = new Headers({ 'x-other': '1' });
  let nextCalls = 0;
  const out = run(
    listeners[0],
    { provider: 'opencode-go', sessionId: 'session-A', baseURL: OPENCODE_BASE },
    headers,
    () => {
      nextCalls += 1;
      return headers;
    },
  );
  assert.equal(nextCalls, 1);
  assert.equal(out, headers);
  assert.equal(out.get('x-opencode-session'), null);
  assert.equal(out.get('x-other'), '1');
});

test('does not touch a non-OpenCode endpoint', () => {
  const { listeners } = install();
  const out = request(listeners[0], 'session-A', 'https://api.example.com/v1');
  assert.equal(out.get('x-opencode-session'), null);
});

test('matches the hostname exactly, never a subdomain', () => {
  const { listeners } = install();
  const out = request(listeners[0], 'session-A', 'https://evil.opencode.ai/inference/go/v1');
  assert.equal(out.get('x-opencode-session'), null);
});

test('preserves an existing static header regardless of its case', () => {
  const { listeners } = install();
  const headers = new Headers({ 'X-OpenCode-Session': 'static-id' });
  const out = run(listeners[0], { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE }, headers);
  assert.equal(out.get('x-opencode-session'), 'static-id');
});

test('keeps header changes made by downstream listeners', () => {
  const { listeners } = install();
  const out = run(
    listeners[0],
    { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE },
    new Headers(),
    () => new Headers({ 'x-downstream': 'kept' }),
  );
  assert.equal(out.get('x-downstream'), 'kept');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-A');
});

test('calls next exactly once for a matching request', () => {
  const { listeners } = install();
  let nextCalls = 0;
  const out = run(
    listeners[0],
    { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE },
    new Headers(),
    () => {
      nextCalls += 1;
      return new Headers();
    },
  );
  assert.equal(nextCalls, 1);
  assert.equal(out.get('x-opencode-session'), 'dsh-session-A');
});

test('propagates a downstream error unchanged', () => {
  const { listeners } = install();
  const error = new Error('downstream failure');
  assert.throws(
    () =>
      run(
        listeners[0],
        { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE },
        new Headers(),
        () => {
          throw error;
        },
      ),
    (thrown) => thrown === error,
  );
});

test('does not mutate the headers object returned by downstream', () => {
  const { listeners } = install();
  const downstream = new Headers();
  const out = run(
    listeners[0],
    { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE },
    new Headers(),
    () => downstream,
  );
  assert.notEqual(out, downstream);
  assert.equal(downstream.get('x-opencode-session'), null);
});

test('falls back to one stable auxiliary id per plugin instance', () => {
  const { listeners } = install();
  const first = request(listeners[0], undefined);
  const second = request(listeners[0], null);
  const third = request(listeners[0], '');
  assert.match(first.get('x-opencode-session'), /^dsh-aux-[0-9a-f-]{36}$/);
  assert.equal(first.get('x-opencode-session'), second.get('x-opencode-session'));
  assert.equal(first.get('x-opencode-session'), third.get('x-opencode-session'));
});

test('different plugin instances get different fallback ids', () => {
  const first = request(install().listeners[0], undefined);
  const second = request(install().listeners[0], undefined);
  assert.notEqual(first.get('x-opencode-session'), second.get('x-opencode-session'));
});

test('honors custom headerName and prefix', () => {
  const { listeners } = install({ headerName: 'x-my-session', prefix: 's-' });
  const out = request(listeners[0], 'abc');
  assert.equal(out.get('x-my-session'), 's-abc');
  assert.equal(out.get('x-opencode-session'), null);
});

test('an empty prefix produces the bare session id', () => {
  const { listeners } = install({ prefix: '' });
  assert.equal(request(listeners[0], 'abc').get('x-opencode-session'), 'abc');
});

test('honors a custom host, for a reverse proxy in front of OpenCode', () => {
  const { listeners } = install({ host: 'proxy.example.com' });
  const out = request(listeners[0], 'session-P', 'https://proxy.example.com/inference/go/v1');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-P');
});

test('accepts a full URL for host and reduces it to its hostname', () => {
  const { listeners } = install({ host: 'https://proxy.example.com/' });
  const out = request(listeners[0], 'session-P', 'https://proxy.example.com/inference/go/v1');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-P');
});

test('accepts host:port for host and ignores the port when matching', () => {
  const { listeners } = install({ host: 'proxy.example.com:8443' });
  const out = request(listeners[0], 'session-P', 'https://proxy.example.com:8443/inference/go/v1');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-P');
});

test('honors a custom path prefix and normalizes a missing leading slash', () => {
  const { listeners } = install({ host: 'proxy.example.com', pathPrefix: 'v1/' });
  const out = request(listeners[0], 'session-P', 'https://proxy.example.com/v1/chat/completions');
  assert.equal(out.get('x-opencode-session'), 'dsh-session-P');
});

test('a custom host does not widen the default endpoint match', () => {
  const { listeners } = install({ host: 'proxy.example.com' });
  const out = request(listeners[0], 'session-P', OPENCODE_BASE);
  assert.equal(out.get('x-opencode-session'), null);
});

test('path prefix matching is literal, so /v1/ does not match /v10', () => {
  const { listeners } = install({ pathPrefix: '/v1/' });
  const exact = request(listeners[0], 'session-A', 'https://opencode.ai/v1/models');
  const adjacent = request(listeners[0], 'session-A', 'https://opencode.ai/v10/models');
  assert.equal(exact.get('x-opencode-session'), 'dsh-session-A');
  assert.equal(adjacent.get('x-opencode-session'), null);
});

test('a path prefix without a trailing slash also matches longer segments', () => {
  const { listeners } = install({ pathPrefix: '/v1' });
  const adjacent = request(listeners[0], 'session-A', 'https://opencode.ai/v10/models');
  assert.equal(adjacent.get('x-opencode-session'), 'dsh-session-A');
});

test('ignores non-HTTP(S) base URLs even when host and path match', () => {
  const { listeners } = install();
  for (const baseURL of ['ftp://opencode.ai/inference/go/v1', 'file:///inference/go/v1']) {
    assert.equal(request(listeners[0], 'session-A', baseURL).get('x-opencode-session'), null);
  }
});

test('ignores malformed and missing base URLs instead of throwing', () => {
  const { listeners } = install();
  for (const baseURL of [undefined, null, '', 'not a url', 42]) {
    assert.doesNotThrow(() => request(listeners[0], 'session-A', baseURL));
  }
});

test('reserves the digest namespace so safe and hashed ids cannot collide', () => {
  const { listeners } = install();
  const unsafe = request(listeners[0], 'a/b').get('x-opencode-session');
  assert.match(unsafe, /^dsh-h-[0-9a-f]{64}$/);
  const digest = unsafe.slice('dsh-h-'.length);

  // This id is safe by charset and length, but it is exactly the digest of the
  // unsafe id above. It must not be emitted verbatim.
  const reserved = request(listeners[0], `h-${digest}`).get('x-opencode-session');
  const expected = createHash('sha256').update(`h-${digest}`).digest('hex');
  assert.equal(reserved, `dsh-h-${expected}`);
  assert.notEqual(reserved, unsafe);
});

test('safe ids that only start with h- stay readable', () => {
  const { listeners } = install();
  assert.equal(request(listeners[0], 'h-abc').get('x-opencode-session'), 'dsh-h-abc');
});

test('an unsafe session id becomes a deterministic digest, avoiding collisions', () => {
  const { listeners } = install();
  const slash = request(listeners[0], 'session/A').get('x-opencode-session');
  const dash = request(listeners[0], 'session-A').get('x-opencode-session');
  assert.match(slash, /^dsh-h-[0-9a-f]{64}$/);
  assert.equal(slash, request(listeners[0], 'session/A').get('x-opencode-session'));
  assert.notEqual(slash, dash);
  assert.equal(dash, 'dsh-session-A');
});

test('session ids that only differ after the old truncation point stay distinct', () => {
  const { listeners } = install();
  const prefix = 'a'.repeat(128);
  const first = request(listeners[0], `${prefix}b`).get('x-opencode-session');
  const second = request(listeners[0], `${prefix}c`).get('x-opencode-session');
  assert.match(first, /^dsh-h-[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test('a 128-character safe id keeps the readable form', () => {
  const { listeners } = install();
  const id = 'a'.repeat(128);
  assert.equal(request(listeners[0], id).get('x-opencode-session'), `dsh-${id}`);
});

test('non-ASCII session ids are hashed deterministically as UTF-8', () => {
  const { listeners } = install();
  const first = request(listeners[0], '会话-一').get('x-opencode-session');
  const second = request(listeners[0], '会话-一').get('x-opencode-session');
  assert.match(first, /^dsh-h-[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, request(listeners[0], '会话-二').get('x-opencode-session'));
});

test('interleaved sessions keep stable, distinct ids', () => {
  const { listeners } = install();
  const a1 = request(listeners[0], 'alpha').get('x-opencode-session');
  const b1 = request(listeners[0], 'beta').get('x-opencode-session');
  const a2 = request(listeners[0], 'alpha').get('x-opencode-session');
  const b2 = request(listeners[0], 'beta').get('x-opencode-session');
  assert.equal(a1, a2);
  assert.equal(b1, b2);
  assert.notEqual(a1, b1);
});

test('validate headerName at load time instead of inside a request', () => {
  for (const headerName of ['bad header', 'x\ny', 'x:y', '', 42]) {
    assertConfigError({ headerName }, 'headerName');
  }
});

test('validate prefix at load time', () => {
  for (const prefix of ['dsh\n', '中文-', ' '.repeat(1) + 'dsh-', 'dsh- ', 42, 'a'.repeat(65)]) {
    assertConfigError({ prefix }, 'prefix');
  }
});

test('validate host at load time', () => {
  for (const host of ['', 'opencode.ai/inference', 'user:pass@opencode.ai', 'ftp://opencode.ai/', 42]) {
    assertConfigError({ host }, 'host');
  }
});

test('validate pathPrefix at load time', () => {
  for (const pathPrefix of ['/v1?x=1', '/v1#frag', '/v 1', '/v1\ntail', '/v1/中文', 42]) {
    assertConfigError({ pathPrefix }, 'pathPrefix');
  }
});

test('validate providers at load time', () => {
  for (const providers of ['route', ['ok', ''], [42], [null]]) {
    assertConfigError({ providers }, 'providers');
  }
});

test('validate debugLog at load time', () => {
  for (const debugLog of ['', '   ', 42]) {
    assertConfigError({ debugLog }, 'debugLog');
  }
});

test('debug log writes one escaped line per injection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-session-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'session.log');
  const { listeners } = install({ debugLog: logPath });
  request(listeners[0], 'line\nbreak');

  const lines = readFileSync(logPath, 'utf8').split('\n');
  assert.equal(lines.length, 2, 'expected exactly one terminated log line');
  const fields = lines[0].split('\t');
  assert.equal(fields.length, 4);
  assert.equal(fields[1], ROUTE);
  assert.equal(fields[2], 'line\\nbreak');
  assert.match(fields[3], /^dsh-h-[0-9a-f]{64}$/);
});

test('a failing debug log never fails the request', () => {
  const { listeners } = install({ debugLog: join(tmpdir(), 'missing-dir', 'session.log') });
  assert.doesNotThrow(() => request(listeners[0], 'session-A'));
  assert.equal(request(listeners[0], 'session-A').get('x-opencode-session'), 'dsh-session-A');
});

test('dispose removes the listener', () => {
  const { ctx, listeners } = install();
  assert.equal(listeners.length, 1);
  ctx.dispose?.();
  assert.equal(listeners.length, 0);
});
