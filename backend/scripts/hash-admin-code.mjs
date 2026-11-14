import { createHash } from 'node:crypto';

if (!process.stdin.isTTY) {
  console.error('Run this command in an interactive terminal. The code is entered privately.');
  process.exit(1);
}
process.stdout.write('Admin code from your password manager (32-128 printable characters): ');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let code = '';
function finish() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\n');
}
process.stdin.on('data', chunk => {
  for (const character of chunk) {
    if (character === '\u0003') { finish(); process.exit(130); }
    if (character === '\r' || character === '\n') {
      finish();
      if (!/^[\x21-\x7e]{32,128}$/.test(code)) {
        console.error('Use a random code with 32-128 printable ASCII characters and no spaces.');
        process.exit(1);
      }
      console.log(`ADMIN_CODE_SHA256="${createHash('sha256').update(code).digest('hex')}"`);
      code = '';
      process.exit(0);
    }
    if (character === '\u007f' || character === '\b') code = code.slice(0, -1);
    else if (code.length < 129) code += character;
  }
});
