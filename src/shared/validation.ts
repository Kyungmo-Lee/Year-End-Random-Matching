// 화면과 서버가 함께 쓰는 입력 정규화·길이 규칙.
// 길이는 NFC 정규화 후 Unicode 코드 포인트 수로 센다(SQLite length()와 같은 기준).

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 20,
  goalMin: 1,
  goalMax: 100,
  rosterNameMax: 30,
  eventNameMax: 50,
  budgetMax: 100,
  rosterMin: 2,
  rosterMax: 99,
  smallGroup: 4,
} as const;

export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ACCESS_CODE_LENGTH = 16;

export type Cleaned<T> = { ok: true; value: T } | { ok: false; message: string };

// 제어 문자, 짝 없는 surrogate, 사설 영역, 보이지 않는 서식 문자(ZWJ 제외).
const FORBIDDEN = /[\p{Cc}\p{Cs}\p{Co}\u200B\u200C\u200E\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/u;

export function charLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function singleLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function normalizeNickname(nickname: string): string {
  return nickname.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function normalizeRosterName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

export function cleanNickname(raw: unknown): Cleaned<{ nickname: string; normalized: string }> {
  if (typeof raw !== 'string') return { ok: false, message: '닉네임을 입력해 주세요.' };
  const nickname = raw.normalize('NFC').trim();
  if (FORBIDDEN.test(nickname)) return { ok: false, message: '닉네임에 사용할 수 없는 문자가 있습니다.' };
  const length = charLength(nickname);
  if (length < LIMITS.nicknameMin || length > LIMITS.nicknameMax) {
    return { ok: false, message: `닉네임은 ${LIMITS.nicknameMin}~${LIMITS.nicknameMax}자로 입력해 주세요.` };
  }
  const normalized = normalizeNickname(nickname);
  if (charLength(normalized) < 1) return { ok: false, message: '닉네임을 입력해 주세요.' };
  return { ok: true, value: { nickname, normalized } };
}

/** 목표 본문. 줄바꿈은 허용하고 그 밖의 제어 문자는 거부한다. */
export function cleanGoal(raw: unknown, options: { allowEmpty: boolean }): Cleaned<string> {
  if (typeof raw !== 'string') return { ok: false, message: '목표를 입력해 주세요.' };
  const goal = raw.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (FORBIDDEN.test(goal.replace(/\n/g, ''))) return { ok: false, message: '목표에 사용할 수 없는 문자가 있습니다.' };
  const length = charLength(goal);
  if (length > LIMITS.goalMax) return { ok: false, message: `목표는 ${LIMITS.goalMax}자 이내로 입력해 주세요.` };
  if (!options.allowEmpty && length < LIMITS.goalMin) return { ok: false, message: '목표를 입력해 주세요.' };
  return { ok: true, value: goal };
}

export function cleanRosterName(raw: unknown): Cleaned<{ displayName: string; normalized: string }> {
  const displayName = singleLine(raw);
  if (displayName === null || displayName === '') return { ok: false, message: '이름을 입력해 주세요.' };
  if (FORBIDDEN.test(displayName)) return { ok: false, message: '이름에 사용할 수 없는 문자가 있습니다.' };
  if (charLength(displayName) > LIMITS.rosterNameMax) {
    return { ok: false, message: `이름은 ${LIMITS.rosterNameMax}자 이내로 입력해 주세요.` };
  }
  const normalized = normalizeRosterName(displayName);
  if (normalized === '') return { ok: false, message: '이름을 입력해 주세요.' };
  return { ok: true, value: { displayName, normalized } };
}

export function cleanEventName(raw: unknown): Cleaned<string> {
  const name = singleLine(raw);
  if (name === null || name === '') return { ok: false, message: '행사명을 입력해 주세요.' };
  if (FORBIDDEN.test(name)) return { ok: false, message: '행사명에 사용할 수 없는 문자가 있습니다.' };
  if (charLength(name) > LIMITS.eventNameMax) {
    return { ok: false, message: `행사명은 ${LIMITS.eventNameMax}자 이내로 입력해 주세요.` };
  }
  return { ok: true, value: name };
}

export function cleanBudgetNote(raw: unknown): Cleaned<string> {
  const note = singleLine(raw);
  if (note === null) return { ok: false, message: '예산 안내를 확인해 주세요.' };
  if (FORBIDDEN.test(note)) return { ok: false, message: '예산 안내에 사용할 수 없는 문자가 있습니다.' };
  if (charLength(note) > LIMITS.budgetMax) {
    return { ok: false, message: `예산 안내는 ${LIMITS.budgetMax}자 이내로 입력해 주세요.` };
  }
  return { ok: true, value: note };
}

/** 사용자가 입력한 접속 코드에서 구분 기호를 제거한다. 형식이 맞지 않으면 null. */
export function normalizeAccessCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ACCESS_CODE_LENGTH) return null;
  for (const ch of code) if (!ACCESS_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function formatAccessCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

export function formatGiftNumber(number: number): string {
  return String(number).padStart(2, '0');
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC ISO 시각을 `<input type="datetime-local">` 용 한국 시각 문자열로 바꾼다. */
export function utcToKstInput(iso: string | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time + KST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 한국 시각 `YYYY-MM-DDTHH:mm` 입력을 UTC ISO 문자열로 바꾼다. 형식이 틀리면 null. */
export function kstInputToUtc(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}:00+09:00`);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

export function formatKst(iso: string | null): string {
  if (!iso) return '-';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(time));
}

export const INVITE_CODE_LENGTH = 8;

/** 참여 비밀번호(관리자가 발급해 전달하는 8자리)에서 구분 기호를 제거한다. 형식이 맞지 않으면 null. */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of code) if (!ACCESS_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
