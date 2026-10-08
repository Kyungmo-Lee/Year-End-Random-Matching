// 관리자 비밀번호 검증 값 생성 도구.
//
//   npm run hash-password
//
// 비밀번호를 화면에 표시하지 않고 입력받아 `pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>` 를 출력한다.
// 출력 값을 ADMIN_PASSWORD_HASH secret 으로 등록한다. 비밀번호 원문은 어디에도 저장하지 않는다.

import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Workers 런타임의 PBKDF2 는 최대 100,000회까지 지원한다.
export const DEFAULT_ITERATIONS = 100_000;

const toHex = (bytes) => Buffer.from(bytes).toString('hex');

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2-sha256:${iterations}:${toHex(salt)}:${toHex(derived)}`;
}

export function randomSecret(bytes = 32) {
  return toHex(webcrypto.getRandomValues(new Uint8Array(bytes)));
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) {
      // 파이프 입력: 첫 줄을 비밀번호로 사용한다.
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => (data += chunk));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
      return;
    }
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('취소했습니다.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const iterationsArg = process.argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : DEFAULT_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1000 || iterations > DEFAULT_ITERATIONS) {
    throw new Error(`--iterations 는 1000~${DEFAULT_ITERATIONS} 사이여야 합니다.`);
  }
  const password = await readHidden('관리자 비밀번호: ');
  if (password.length < 12) throw new Error('비밀번호는 12자 이상으로 정해 주세요.');
  if (process.stdin.isTTY) {
    const again = await readHidden('한 번 더 입력: ');
    if (again !== password) throw new Error('두 입력이 일치하지 않습니다.');
  }
  process.stdout.write(`${await hashPassword(password, iterations)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
