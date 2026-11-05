/**
 * Pack the plugin the way npm would, then verify the tarball contents and that
 * the packaged entry point still works. This intentionally uses the real
 * `npm pack` file selection instead of duplicating the `files` list.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const ALLOWED = new Set([
  'package.json',
  'lib/index.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

function fail(message) {
  throw new Error(`package:check: ${message}`);
}

const workspace = mkdtempSync(join(tmpdir(), 'dsh-opencode-session-check-'));
const extractedRoot = join(workspace, 'extracted');

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedName = `${pkg.name}-${pkg.version}.tgz`;

  const packed = run(npm, ['pack', '--json', '--pack-destination', workspace], { cwd: root });
  let metadata;
  try {
    metadata = JSON.parse(packed.stdout);
  } catch {
    fail(`npm pack did not return JSON:\n${packed.stdout}`);
  }
  if (!Array.isArray(metadata) || metadata.length !== 1) {
    fail(`expected exactly one packed entry, got ${metadata?.length ?? 'none'}`);
  }
  const info = metadata[0];
  if (info.filename !== expectedName) {
    fail(`expected ${expectedName}, got ${info.filename}`);
  }

  const actual = new Set(info.files.map((file) => file.path));
  for (const path of actual) {
    if (!ALLOWED.has(path)) fail(`unexpected file in package: ${path}`);
  }
  for (const path of ALLOWED) {
    if (!actual.has(path)) fail(`missing required file in package: ${path}`);
  }

  const tarball = join(workspace, expectedName);
  mkdirSync(extractedRoot);
  run('tar', ['-xzf', tarball, '-C', extractedRoot], { cwd: workspace });

  const packagedRoot = join(extractedRoot, 'package');
  for (const path of ALLOWED) {
    if (!existsSync(join(packagedRoot, path))) fail(`tarball is missing ${path}`);
  }

  const packagedPkg = JSON.parse(readFileSync(join(packagedRoot, 'package.json'), 'utf8'));
  if (packagedPkg.name !== pkg.name || packagedPkg.version !== pkg.version) {
    fail(`packaged identity ${packagedPkg.name}@${packagedPkg.version} does not match ${pkg.name}@${pkg.version}`);
  }

  // Import the tarball's own entry point, not the workspace copy.
  const moduleUrl = `${pathToFileURL(join(packagedRoot, 'lib/index.js')).href}?check=${Date.now()}`;
  const module = await import(moduleUrl);
  if (module.name !== 'opencode-session') fail(`unexpected plugin name: ${String(module.name)}`);
  if (typeof module.apply !== 'function') fail('packaged entry point does not export apply()');
  if (!Array.isArray(module.inject) || !module.inject.includes('llm')) {
    fail('packaged entry point does not inject the llm service');
  }

  // Exercise the packaged code through a minimal lifecycle context.
  const listeners = [];
  let disposer;
  module.apply(
    {
      on(event, listener) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      effect(install) {
        disposer = install();
      },
      logger: () => ({ debug() {} }),
    },
    { providers: ['opencode-go-extra'] },
  );
  const headers = new Headers();
  const out = listeners[0](
    { provider: 'opencode-go-extra', sessionId: 'smoke', baseURL: 'https://opencode.ai/inference/go/v1' },
    headers,
    () => headers,
  );
  if (out.get('x-opencode-session') !== 'dsh-smoke') {
    fail('packaged entry point did not inject the expected header');
  }
  if (typeof disposer === 'function') disposer();

  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  console.log(`package:check OK ${info.filename} (${info.files.length} files, sha256 ${digest})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
