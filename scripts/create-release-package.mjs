/**
 * Create the release tarball and SHA256SUMS from the current checkout.
 *
 * The release workflow runs this from the tagged commit before creating a
 * draft GitHub Release, so the tarball always matches the tag and package.json.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(root, '.release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  throw new Error(`release:pack: ${message}`);
}

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

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    fail(`package.json version must be a plain x.y.z version, got ${pkg.version}`);
  }

  // Recreate only this repository's ignored release directory.
  if (dirname(releaseDir) !== root || relative(root, releaseDir) !== '.release') {
    fail(`refusing to clean unexpected release directory ${releaseDir}`);
  }
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir);

  const packed = run(npm, ['pack', '--json', '--pack-destination', releaseDir], { cwd: root });
  const metadata = JSON.parse(packed.stdout);
  const expected = `${pkg.name}-${pkg.version}.tgz`;
  if (!Array.isArray(metadata) || metadata.length !== 1 || metadata[0].filename !== expected) {
    fail(`expected exactly ${expected}, got ${JSON.stringify(metadata?.map((entry) => entry.filename))}`);
  }

  const tarball = join(releaseDir, expected);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const checksums = join(releaseDir, 'SHA256SUMS');
  writeFileSync(checksums, `${digest}  ${expected}\n`, { encoding: 'utf8', mode: 0o644 });

  // Re-read both files and verify the recorded digest before reporting success.
  const recorded = readFileSync(checksums, 'utf8').trim().split(/\s+/);
  if (recorded.length !== 2 || recorded[1] !== expected) {
    fail(`malformed ${checksums}`);
  }
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (recorded[0] !== actual) {
    fail(`checksum mismatch: recorded ${recorded[0]}, actual ${actual}`);
  }

  console.log(`release:pack ${expected}`);
  console.log(`sha256 ${actual}`);
  console.log(`files ${relative(root, tarball)}, ${relative(root, checksums)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
