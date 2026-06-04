#!/usr/bin/env node

/**
 * Cross-platform launcher for run-bench.sh.
 *
 * On Linux / macOS `bash` is always on $PATH.
 * On Windows it usually is NOT – Git for Windows puts it under
 * <git-install>/bin/ which is not added to %PATH% by default.
 * This tiny wrapper locates bash automatically so the npm scripts
 * work everywhere without manual PATH tweaks.
 */

import {execFileSync, execSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findBash() {
  if (process.platform !== 'win32') return 'bash';

  // 1. bash already on PATH (e.g. MSYS2, user added manually)
  try {
    execFileSync('bash', ['--version'], {stdio: 'ignore'});
    return 'bash';
  } catch { /* not found */ }

  // 2. Derive from Git for Windows installation
  try {
    const gitExecPath = execSync('git --exec-path', {encoding: 'utf8'}).trim();
    const gitRoot = join(gitExecPath, '..', '..', '..');
    const gitBashCandidates = [
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of gitBashCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* git not found */ }

  // 3. Common default locations
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  console.error(
    'Error: bash not found.\n' +
    'Please install Git for Windows (https://git-scm.com) or add bash to your PATH.',
  );
  process.exit(1);
}

try {
  execFileSync(findBash(), ['run-bench.sh', ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: __dirname,
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
