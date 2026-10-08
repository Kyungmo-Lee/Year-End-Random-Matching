// 로컬 개발 DB(.wrangler/state)를 지운다. 운영 D1 에는 영향이 없다.
import { rmSync } from 'node:fs';

rmSync(new URL('../.wrangler/state', import.meta.url), { recursive: true, force: true });
console.log('로컬 DB 를 지웠습니다. 다음 실행 시 마이그레이션이 다시 적용됩니다.');
