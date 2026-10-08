import { hmacHex, randomToken, sha256Hex, timingSafeEqualText } from './crypto';
import type { Env } from './env';
import { HttpError, nowIso, readCookie, sessionCookie } from './http';

export type Role = 'admin' | 'participant';

// 관리자와 참여자 쿠키를 분리해 주최자가 두 화면을 함께 쓸 수 있게 한다.
const COOKIE_NAME: Record<Role, string> = { admin: 'gx_admin', participant: 'gx_part' };
const SESSION_TTL_SECONDS: Record<Role, number> = { admin: 8 * 60 * 60, participant: 7 * 24 * 60 * 60 };

export interface Session {
  role: Role;
  tokenHash: string;
  participantId: number | null;
  csrfToken: string;
}

export interface NewSession {
  tokenHash: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  cookie: string;
}

function csrfFor(env: Env, tokenHash: string): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `csrf:${tokenHash}`);
}

/** 새 세션 값. DB 에는 tokenHash 만 저장하고 원문 토큰은 쿠키로만 내려준다. */
export async function newSession(env: Env, url: URL, role: Role): Promise<NewSession> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  return {
    tokenHash,
    csrfToken: await csrfFor(env, tokenHash),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_SECONDS[role] * 1000).toISOString(),
    cookie: sessionCookie(url, COOKIE_NAME[role], token, SESSION_TTL_SECONDS[role]),
  };
}

export function clearedCookie(url: URL, role: Role): string {
  return sessionCookie(url, COOKIE_NAME[role], '', 0);
}

export async function loadSession(request: Request, env: Env, role: Role): Promise<Session | null> {
  const token = readCookie(request, COOKIE_NAME[role]);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256Hex(token);
  // 참여자 세션은 발급 당시 credential_version 이 현재 값과 같을 때만 유효하다(재발급 시 무효화).
  const row = await env.DB.prepare(
    `SELECT s.participant_id
       FROM sessions s LEFT JOIN participants p ON p.id = s.participant_id
      WHERE s.token_hash = ?1 AND s.role = ?2 AND s.expires_at > ?3
        AND (s.role = 'admin' OR (p.id IS NOT NULL AND p.credential_version = s.credential_version))`,
  )
    .bind(tokenHash, role, nowIso())
    .first<{ participant_id: number | null }>();
  if (!row) return null;
  return { role, tokenHash, participantId: row.participant_id, csrfToken: await csrfFor(env, tokenHash) };
}

/** 세션을 요구한다. 상태를 바꾸는 요청은 csrf: true 로 X-CSRF-Token 헤더까지 검증한다. */
export async function requireSession(
  request: Request,
  env: Env,
  role: Role,
  options: { csrf: boolean },
): Promise<Session> {
  const session = await loadSession(request, env, role);
  if (!session) {
    if (role === 'participant') {
      const event = await env.DB.prepare('SELECT status FROM event WHERE id = 1').first<{ status: string }>();
      if (event?.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
    }
    throw new HttpError(401, 'UNAUTHENTICATED', role === 'admin' ? '관리자 로그인이 필요합니다.' : '접속 코드로 다시 접속해 주세요.');
  }
  if (options.csrf) {
    const header = request.headers.get('X-CSRF-Token') ?? '';
    if (!timingSafeEqualText(header, session.csrfToken)) {
      throw new HttpError(403, 'CSRF', '요청을 확인할 수 없습니다. 새로 고침 후 다시 시도해 주세요.');
    }
  }
  return session;
}

// ---- 로그인 시도 제한 -------------------------------------------------------

export interface RateRule {
  maxFailures: number;
  windowSeconds: number;
  blockSeconds: number;
}

// 같은 공유망(사무실 Wi-Fi 등)에서 여러 명이 접속하는 상황을 고려한 임계치.
export const RATE_RULES = {
  accessIp: { maxFailures: 10, windowSeconds: 600, blockSeconds: 600 },
  registerIp: { maxFailures: 10, windowSeconds: 600, blockSeconds: 600 },
  adminIp: { maxFailures: 5, windowSeconds: 600, blockSeconds: 900 },
  adminGlobal: { maxFailures: 100, windowSeconds: 600, blockSeconds: 300 },
} satisfies Record<string, RateRule>;

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** IP 원문 대신 서버 secret 기반 해시를 저장한다. */
export function scopeHash(env: Env, scope: string): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `scope:${scope}`);
}

export async function assertNotBlocked(env: Env, scopeHashes: string[]): Promise<void> {
  const now = nowIso();
  for (const hash of scopeHashes) {
    const row = await env.DB.prepare('SELECT blocked_until FROM auth_attempts WHERE scope_hash = ?1 AND blocked_until > ?2')
      .bind(hash, now)
      .first<{ blocked_until: string }>();
    if (row) {
      const seconds = Math.max(1, Math.ceil((Date.parse(row.blocked_until) - Date.now()) / 1000));
      throw new HttpError(429, 'RATE_LIMITED', '시도 횟수가 많습니다. 잠시 후 다시 시도해 주세요.', {
        'Retry-After': String(seconds),
      });
    }
  }
}

export async function recordFailure(env: Env, hash: string, rule: RateRule): Promise<void> {
  const now = Date.now();
  const nowText = new Date(now).toISOString();
  const windowCutoff = new Date(now - rule.windowSeconds * 1000).toISOString();
  const blockUntil = new Date(now + rule.blockSeconds * 1000).toISOString();
  // UPDATE SET 의 우변은 모두 갱신 전 값을 기준으로 계산된다.
  await env.DB.prepare(
    `INSERT INTO auth_attempts (scope_hash, window_start, failures, blocked_until)
     VALUES (?1, ?2, 1, CASE WHEN ?4 <= 1 THEN ?5 ELSE NULL END)
     ON CONFLICT (scope_hash) DO UPDATE SET
       failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END,
       blocked_until = CASE
         WHEN (CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END) >= ?4 THEN ?5
         ELSE blocked_until END`,
  )
    .bind(hash, nowText, windowCutoff, rule.maxFailures, blockUntil)
    .run();
}

export async function clearFailures(env: Env, hash: string): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE scope_hash = ?1').bind(hash).run();
}
