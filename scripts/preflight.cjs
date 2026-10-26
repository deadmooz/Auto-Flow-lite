// Runs before `npm start` and from the launchers. Plain old JavaScript on purpose: it must run (and explain
// itself) on ANY Node version, including ones too old for the app.
'use strict';

const [major, minor] = process.versions.node.split('.').map(Number);
const MIN = [22, 13];
const tooOld = major < MIN[0] || (major === MIN[0] && minor < MIN[1]);

if (tooOld) {
  console.error('');
  console.error('  LiteForeFlow needs Node.js ' + MIN.join('.') + ' or newer, but this computer has ' + process.versions.node + '.');
  console.error('');
  console.error('  Fix (takes about 2 minutes):');
  console.error('    1. Go to https://nodejs.org');
  console.error('    2. Download the "LTS" installer and run it (click Next until it finishes)');
  console.error('    3. Close this window, open a new one, and start LiteForeFlow again');
  console.error('');
  process.exit(1);
}

try {
  require('node:sqlite'); // the built-in database; no separate install needed
} catch (e) {
  console.error('\n  This Node.js build has no built-in database support. Please install the current LTS from https://nodejs.org\n');
  process.exit(1);
}
