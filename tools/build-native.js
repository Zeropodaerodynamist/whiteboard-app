'use strict';
// Builds the Rust parts (native/) and puts the results where the app loads them:
//   bin/swbd-ink.exe   offline handwriting recognition (Windows Ink), used by the desktop app
// Usage: node tools/build-native.js   (needs Rust)

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const run = (args) => execFileSync('cargo', args, { cwd: NATIVE, stdio: 'inherit' });

// Panic messages name source files by absolute path, which would put the builder's user
// name and folders into the published binaries. Map them to neutral prefixes. Passed with
// --config, these are added to any rustflags already configured, not replacing them.
const remap = JSON.stringify([[os.homedir(), '~'], [ROOT, 'whiteboard']].map(([from, to]) => `--remap-path-prefix=${from}=${to}`));

// [cargo package, executable, built on]: handwriting recognition uses Windows Ink, so Windows only.
const TOOLS = [['swbd-ink', 'swbd-ink', ['win32']]];


const here = TOOLS.filter(([, , on]) => on.includes(process.platform));
if (!here.length) {
  console.log('Nothing native to build here: handwriting recognition is Windows-only.');
} else {
  run(['build', '--release', ...here.flatMap(([pkg]) => ['-p', pkg]), '--config', `build.rustflags=${remap}`]);
  fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const [, exe] of here) {
    fs.copyFileSync(path.join(NATIVE, 'target', 'release', exe + ext), path.join(ROOT, 'bin', exe + ext));
    console.log('bin/' + exe + ext);
  }
}
