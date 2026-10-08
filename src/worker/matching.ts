// 매칭 계산(순수 함수). DB 저장은 matchService.ts 가 맡는다.

export interface MatchPlan {
  /** s: 산타 참여자 ID, r: 받는 사람 참여자 ID */
  pairs: { s: number; r: number }[];
  /** p: 참여자 ID, n: 선물 번호(1~99) */
  numbers: { p: number; n: number }[];
}

export const MAX_PARTICIPANTS = 99;

/** [0, maxExclusive) 범위의 편향 없는 정수. Web Crypto 난수에 기각 추출을 적용한다. */
export function randomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
    throw new Error('randomInt: invalid range');
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < limit) return value % maxExclusive;
  }
}

/** Sattolo: 길이 n 의 단일 사이클 순열을 균등하게 뽑는다. 결과[i] 는 i 가 가리키는 위치. */
export function sattolo(n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i >= 1; i--) {
    const j = randomInt(i); // 0 <= j < i (자기 자신 제외가 Fisher–Yates 와의 차이)
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  return perm;
}

/** 01~99 중 count 개를 중복 없이 뽑는다. */
export function pickGiftNumbers(count: number): number[] {
  const pool = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => i + 1);
  for (let i = pool.length - 1; i >= 1; i--) {
    const j = randomInt(i + 1);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

export function buildMatchPlan(participantIds: readonly number[]): MatchPlan {
  const n = participantIds.length;
  if (n < 2 || n > MAX_PARTICIPANTS) throw new Error('buildMatchPlan: participant count out of range');
  const perm = sattolo(n);
  const numbers = pickGiftNumbers(n);
  const plan: MatchPlan = {
    pairs: participantIds.map((id, i) => ({ s: id, r: participantIds[perm[i]!]! })),
    numbers: participantIds.map((id, i) => ({ p: id, n: numbers[i]! })),
  };
  assertValidPlan(participantIds, plan);
  return plan;
}

/** 1:1, 자기 배정 없음, 단일 사이클, 번호 유일성을 검사한다. 위반 시 예외. */
export function assertValidPlan(participantIds: readonly number[], plan: MatchPlan): void {
  const n = participantIds.length;
  const ids = new Set(participantIds);
  if (ids.size !== n || n < 2 || n > MAX_PARTICIPANTS) throw new Error('match plan: invalid participant set');
  if (plan.pairs.length !== n || plan.numbers.length !== n) throw new Error('match plan: size mismatch');

  const next = new Map<number, number>();
  const receivers = new Set<number>();
  for (const { s, r } of plan.pairs) {
    if (!ids.has(s) || !ids.has(r)) throw new Error('match plan: unknown participant');
    if (s === r) throw new Error('match plan: self assignment');
    if (next.has(s)) throw new Error('match plan: duplicate santa');
    if (receivers.has(r)) throw new Error('match plan: duplicate receiver');
    next.set(s, r);
    receivers.add(r);
  }

  let cursor = participantIds[0]!;
  for (let step = 1; step <= n; step++) {
    cursor = next.get(cursor)!;
    if (cursor === participantIds[0] && step !== n) throw new Error('match plan: not a single cycle');
  }
  if (cursor !== participantIds[0]) throw new Error('match plan: not a single cycle');

  const numbered = new Set<number>();
  const used = new Set<number>();
  for (const { p, n: number } of plan.numbers) {
    if (!ids.has(p) || numbered.has(p)) throw new Error('match plan: invalid number owner');
    if (!Number.isInteger(number) || number < 1 || number > 99 || used.has(number)) {
      throw new Error('match plan: invalid gift number');
    }
    numbered.add(p);
    used.add(number);
  }
}
