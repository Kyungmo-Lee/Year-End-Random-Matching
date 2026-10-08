import { ACCESS_CODE_ALPHABET, ACCESS_CODE_LENGTH, INVITE_CODE_LENGTH } from '../shared/validation';

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** 256비트 무작위 토큰(base64url). 세션 토큰·작업 토큰·매칭 실행 ID에 사용한다. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** 혼동 문자를 뺀 32자 알파벳 16자리(80비트). 32는 256의 약수라 편향이 없다. */
export function generateAccessCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ACCESS_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += ACCESS_CODE_ALPHABET[byte & 31];
  return code;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * `pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>` 검증 값과 비밀번호를 비교한다.
 * scripts/hash-password.mjs 가 같은 형식을 만든다. 셸·dotenv 에서 안전하도록 `$` 를 쓰지 않는다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  const salt = fromHex(parts[2]!);
  const expected = fromHex(parts[3]!);
  if (!salt || !expected) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    expected.length * 8,
  );
  return timingSafeEqual(new Uint8Array(derived), expected);
}

/** 참여 비밀번호: 같은 알파벳 8자리(40비트). 등록 시도 제한과 함께 사용한다. */
export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += ACCESS_CODE_ALPHABET[byte & 31];
  return code;
}

/** 참여 비밀번호의 저장용 값. 명단 ID 를 섞어 다른 사람의 비밀번호로는 통과할 수 없게 한다. */
export function inviteHash(secret: string, rosterId: number, code: string): Promise<string> {
  return hmacHex(secret, `invite:${rosterId}:${code}`);
}
