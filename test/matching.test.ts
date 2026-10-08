import { describe, expect, it } from 'vitest';
import {
  charLength,
  cleanGoal,
  cleanNickname,
  cleanRosterName,
  kstInputToUtc,
  normalizeAccessCode,
  utcToKstInput,
} from '../src/shared/validation';
import { verifyPassword } from '../src/worker/crypto';
import { assertValidPlan, buildMatchPlan, pickGiftNumbers, randomInt, sattolo } from '../src/worker/matching';
import { count, expectValidStoredMatch, matchedEvent } from './helpers';

/** assertValidPlan 과 별개로 작성한 검사. */
function checkPlan(ids: number[], plan: ReturnType<typeof buildMatchPlan>): void {
  const n = ids.length;
  const next = new Map(plan.pairs.map((pair) => [pair.s, pair.r]));
  expect(next.size).toBe(n);
  expect(new Set(next.values()).size).toBe(n); // 1:1
  for (const [santa, receiver] of next) expect(santa).not.toBe(receiver); // 자기 배정 없음
  const visited = new Set<number>();
  let cursor = ids[0]!;
  while (!visited.has(cursor)) {
    visited.add(cursor);
    cursor = next.get(cursor)!;
  }
  expect(visited.size).toBe(n); // 단일 사이클
  const numbers = plan.numbers.map((item) => item.n);
  expect(new Set(numbers).size).toBe(n); // 번호 유일성
  expect(Math.min(...numbers)).toBeGreaterThanOrEqual(1);
  expect(Math.max(...numbers)).toBeLessThanOrEqual(99);
  expect(new Set(plan.numbers.map((item) => item.p))).toEqual(new Set(ids));
}

describe('매칭 계산', () => {
  it('2~99명 모두 1:1·자기 배정 없음·단일 사이클·번호 유일성을 만족한다', () => {
    for (let n = 2; n <= 99; n++) {
      for (let round = 0; round < 25; round++) {
        const ids = Array.from({ length: n }, (_, i) => 1000 + i * 3);
        checkPlan(ids, buildMatchPlan(ids));
      }
    }
  });

  it('범위를 벗어난 인원은 거부한다', () => {
    expect(() => buildMatchPlan([1])).toThrow();
    expect(() => buildMatchPlan(Array.from({ length: 100 }, (_, i) => i + 1))).toThrow();
  });

  it('검증 함수가 잘못된 결과를 잡아낸다', () => {
    const ids = [1, 2, 3, 4];
    const numbers = [{ p: 1, n: 1 }, { p: 2, n: 2 }, { p: 3, n: 3 }, { p: 4, n: 4 }];
    const cycle = [{ s: 1, r: 2 }, { s: 2, r: 3 }, { s: 3, r: 4 }, { s: 4, r: 1 }];
    expect(() => assertValidPlan(ids, { pairs: cycle, numbers })).not.toThrow();
    // 두 개의 2-사이클
    expect(() => assertValidPlan(ids, { pairs: [{ s: 1, r: 2 }, { s: 2, r: 1 }, { s: 3, r: 4 }, { s: 4, r: 3 }], numbers })).toThrow(/single cycle/);
    expect(() => assertValidPlan(ids, { pairs: [{ s: 1, r: 1 }, { s: 2, r: 3 }, { s: 3, r: 4 }, { s: 4, r: 2 }], numbers })).toThrow(/self/);
    expect(() => assertValidPlan(ids, { pairs: [{ s: 1, r: 2 }, { s: 2, r: 3 }, { s: 3, r: 2 }, { s: 4, r: 1 }], numbers })).toThrow(/duplicate receiver/);
    expect(() => assertValidPlan(ids, { pairs: cycle, numbers: [...numbers.slice(0, 3), { p: 4, n: 3 }] })).toThrow(/gift number/);
    expect(() => assertValidPlan(ids, { pairs: cycle, numbers: [...numbers.slice(0, 3), { p: 4, n: 100 }] })).toThrow(/gift number/);
  });

  it('Sattolo 는 3명일 때 두 가지 사이클을 모두 만든다', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(sattolo(3).join(''));
    expect(seen).toEqual(new Set(['120', '201']));
  });

  it('난수 범위와 번호 추출', () => {
    for (let i = 0; i < 500; i++) {
      const value = randomInt(7);
      expect(value >= 0 && value < 7).toBe(true);
    }
    expect(randomInt(1)).toBe(0);
    expect(new Set(pickGiftNumbers(99)).size).toBe(99);
  });

  it('99명을 실제 D1 에 저장해도 불변식을 만족한다', async () => {
    await matchedEvent(99);
    await expectValidStoredMatch(99);
    expect(await count('tx_guard')).toBe(0);
  });
});

describe('입력 규칙', () => {
  it('길이는 코드 포인트 기준이다', () => {
    expect(charLength('가나다')).toBe(3);
    expect(charLength('🎁🎄')).toBe(2);
    expect(charLength('e\u0301'.normalize('NFC'))).toBe(1);
  });

  it('닉네임 2~20자와 정규화', () => {
    expect(cleanNickname('가').ok).toBe(false);
    expect(cleanNickname(' 가 ').ok).toBe(false);
    expect(cleanNickname('가'.repeat(21)).ok).toBe(false);
    expect(cleanNickname('🎁'.repeat(20)).ok).toBe(true);
    expect(cleanNickname('산타\u0000').ok).toBe(false);
    expect(cleanNickname('산타\u200B요정').ok).toBe(false);
    expect(cleanNickname(42).ok).toBe(false);
    const a = cleanNickname('  Santa  ');
    const b = cleanNickname('ｓａｎｔａ');
    expect(a.ok && a.value.nickname).toBe('Santa');
    expect(a.ok && b.ok && a.value.normalized === b.value.normalized).toBe(true);
  });

  it('목표 1~100자', () => {
    expect(cleanGoal('', { allowEmpty: false }).ok).toBe(false);
    expect(cleanGoal('', { allowEmpty: true }).ok).toBe(true);
    expect(cleanGoal('가'.repeat(100), { allowEmpty: false }).ok).toBe(true);
    expect(cleanGoal('가'.repeat(101), { allowEmpty: false }).ok).toBe(false);
    expect(cleanGoal('🎁'.repeat(100), { allowEmpty: false }).ok).toBe(true);
    const multi = cleanGoal('첫 줄\r\n둘째 줄', { allowEmpty: false });
    expect(multi.ok && multi.value).toBe('첫 줄\n둘째 줄');
  });

  it('명단 이름은 공백을 무시하고 비교한다', () => {
    const a = cleanRosterName('김 민수');
    const b = cleanRosterName('김민수');
    expect(a.ok && b.ok && a.value.normalized === b.value.normalized).toBe(true);
  });

  it('접속 코드와 한국 시각 변환', () => {
    expect(normalizeAccessCode('abcd-efgh-jklm-npqr')).toBe('ABCDEFGHJKLMNPQR');
    expect(normalizeAccessCode('ABCD-EFGH-JKLM-NPQ0')).toBeNull(); // 0 은 알파벳에 없다
    expect(normalizeAccessCode('short')).toBeNull();
    expect(kstInputToUtc('2026-12-31T23:59')).toBe('2026-12-31T14:59:00.000Z');
    expect(utcToKstInput('2026-12-31T14:59:00.000Z')).toBe('2026-12-31T23:59');
  });

  it('비밀번호 검증 값 형식', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256:1000:zz:zz')).toBe(false);
  });
});
