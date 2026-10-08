// 로컬 개발용 .dev.vars 생성.
//
//   npm run setup:local            # 없을 때만 생성
//   npm run setup:local -- --force # 새 값으로 다시 생성
//
// 무작위 SESSION_SECRET 과 무작위 로컬 관리자 비밀번호를 만들고, 비밀번호는 이때 한 번만 출력한다.
// .dev.vars 는 .gitignore 대상이며 운영 secret 으로 재사용하지 않는다.

import { existsSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { hashPassword, randomSecret } from './hash-password.mjs';

const target = new URL('../.dev.vars', import.meta.url);
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.log('.dev.vars 가 이미 있습니다. 다시 만들려면: npm run setup:local -- --force');
  process.exit(0);
}

const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from(webcrypto.getRandomValues(new Uint8Array(16)), (byte) => alphabet[byte % alphabet.length]).join('');

writeFileSync(
  target,
  [
    '# 로컬 개발 전용. 저장소에 올리지 않는다.',
    `SESSION_SECRET="${randomSecret()}"`,
    `ADMIN_PASSWORD_HASH="${await hashPassword(password)}"`,
    '',
  ].join('\n'),
);

console.log('.dev.vars 를 만들었습니다.');
console.log(`로컬 관리자 비밀번호(지금만 표시됩니다): ${password}`);
