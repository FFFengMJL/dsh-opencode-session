import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

const OPENCODE_BASE = 'https://opencode.ai/inference/go/v1';
const ROUTE = 'opencode-go-extra';

// Cordis FiberState values: 2 = ACTIVE, 3 = FAILED, 4 = DISPOSED.
const ACTIVE = 2;
const FAILED = 3;
const DISPOSED = 4;

/** Create a root Cordis context whose `llm` service satisfies the plugin inject. */
function makeRoot() {
  const root = new Context();
  root.provide('llm', {});
  return root;
}

/** Dispatch the request-header waterfall through a real Cordis event bus. */
function dispatch(root, request) {
  const headers = new Headers();
  return root.waterfall('llm-pi-ai/request-headers', request, headers, () => headers);
}

test('loads through a real Cordis fiber, injects, and cleans up on dispose', async () => {
  const root = makeRoot();
  const fiber = root.plugin(plugin, { providers: [ROUTE] });
  await fiber;
  assert.equal(fiber.state, ACTIVE);

  const out = dispatch(root, { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE });
  assert.equal(out.get('x-opencode-session'), 'dsh-session-A');

  await fiber.dispose();
  assert.equal(fiber.state, DISPOSED);

  const after = dispatch(root, { provider: ROUTE, sessionId: 'session-A', baseURL: OPENCODE_BASE });
  assert.equal(after.get('x-opencode-session'), null);
});

test('can be mounted again after disposal without leaking listeners', async () => {
  const root = makeRoot();
  const first = root.plugin(plugin, { providers: [ROUTE] });
  await first;
  await first.dispose();

  const second = root.plugin(plugin, { providers: [ROUTE] });
  await second;
  const out = dispatch(root, { provider: ROUTE, sessionId: 'session-B', baseURL: OPENCODE_BASE });
  assert.equal(out.get('x-opencode-session'), 'dsh-session-B');
  await second.dispose();
});

test('invalid row config fails the fiber at load time', async () => {
  const root = makeRoot();
  const fiber = root.plugin(plugin, { providers: [ROUTE], headerName: 'bad header' });
  await assert.rejects(fiber.await(), /invalid "headerName"/);
  assert.equal(fiber.state, FAILED);
});
