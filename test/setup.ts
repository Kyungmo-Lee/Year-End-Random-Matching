import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { resetDb } from './helpers';

// 운영과 같은 마이그레이션 파일을 로컬 D1 에 적용한다.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(resetDb);
