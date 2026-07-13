import { spawn } from 'node:child_process';

const args = ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'];
const commands = process.env.YTMUSIC_PYTHON
  ? [process.env.YTMUSIC_PYTHON]
  : process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python'];

function run(index: number): void {
  const command = commands[index];
  const child = spawn(command, args, { stdio: 'inherit' });
  let handledSpawnError = false;

  child.on('error', (err: NodeJS.ErrnoException) => {
    handledSpawnError = true;
    if (err.code === 'ENOENT' && index + 1 < commands.length) {
      run(index + 1);
      return;
    }
    console.error(`failed to run ${command}: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    if (handledSpawnError) return;
    process.exit(code ?? 1);
  });
}

run(0);
