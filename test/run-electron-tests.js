'use strict';

// Runs the Electron end-to-end tests: `npm run test:e2e`.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron'); // the binary path when required from Node

// VS Code terminals set this, which would make Electron run as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function run(label, file, extraEnv = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(electron, [path.join(__dirname, file)], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.split('\n').filter((line) => line && !/^\[\d/.test(line)).join('\n');
  process.stdout.write(`${output}\n`);
  if (result.status !== 0) {
    process.stdout.write(`✖ ${label} failed\n`);
    process.exit(1);
  }
}

run('Main flow', 'e2e.electron.js');
const profileData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabfleet-profiles-'));
run('Profile sessions', 'profile-sessions.electron.js', { PROFILE_SESSIONS_PHASE: '1', PROFILE_SESSIONS_DATA: profileData });
run('Profile sessions after restart', 'profile-sessions.electron.js', { PROFILE_SESSIONS_PHASE: '2', PROFILE_SESSIONS_DATA: profileData });
process.stdout.write('\n✔ All Electron tests passed\n');
