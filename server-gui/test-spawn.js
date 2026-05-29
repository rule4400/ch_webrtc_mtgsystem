const { spawn } = require('child_process');
const path = require('path');

function fixMacPath() {
  const envPath = process.env.PATH || '';
  const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  process.env.PATH = Array.from(new Set([...envPath.split(':'), ...extraPaths])).join(':');
}
fixMacPath();

const serverDir = '/Users/kiroku_keizo/開発/webRTC会議室システム/server';
console.log('Spawning in', serverDir, 'with PATH:', process.env.PATH);

const p = spawn('node', ['index.js'], {
  cwd: serverDir,
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
});

p.stdout.on('data', d => console.log('STDOUT:', d.toString()));
p.stderr.on('data', d => console.log('STDERR:', d.toString()));
p.on('error', err => console.error('ERROR:', err));
p.on('close', code => console.log('CLOSED:', code));
