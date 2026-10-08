import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { hashPassword, randomSecret } from './scripts/hash-password.mjs';

// 테스트는 workerd 런타임과 로컬 D1(Miniflare) 위에서 실제 Worker 코드를 실행한다.
// 운영 설정(wrangler.jsonc)과 분리된 일회용 DB 를 쓰고, secret 은 실행할 때마다 새로 만든다.
const TEST_ADMIN_PASSWORD = 'test-only-admin-password';

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: './src/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
        bindings: {
          SESSION_SECRET: randomSecret(),
          // 운영과 같은 도구·같은 반복 횟수로 만든 검증 값
          ADMIN_PASSWORD_HASH: await hashPassword(TEST_ADMIN_PASSWORD),
          TEST_ADMIN_PASSWORD,
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
  },
}));
