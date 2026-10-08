import type { Env } from './env';
import { errorResponse, HttpError, nowIso } from './http';
import { tryAutoMatch } from './matchService';
import * as admin from './routes/admin';
import * as me from './routes/me';
import * as pub from './routes/public';

type Handler = (request: Request, env: Env, url: URL, params: string[]) => Promise<Response>;

const ROUTES: [method: string, pattern: RegExp, handler: Handler][] = [
  ['GET', /^\/api\/event$/, pub.getEvent],
  ['GET', /^\/api\/roster$/, pub.getRoster],
  ['POST', /^\/api\/participants$/, pub.registerParticipant],
  ['POST', /^\/api\/access$/, pub.accessWithCode],
  ['POST', /^\/api\/logout$/, pub.logout],
  ['GET', /^\/api\/results$/, pub.getResults],

  ['GET', /^\/api\/me$/, me.getMe],
  ['PATCH', /^\/api\/me\/goal$/, me.patchGoal],
  ['PATCH', /^\/api\/me\/nickname$/, me.patchNickname],
  ['POST', /^\/api\/me\/submit$/, me.submit],
  ['POST', /^\/api\/me\/assignment\/view$/, me.viewAssignment],

  ['POST', /^\/api\/admin\/login$/, admin.login],
  ['GET', /^\/api\/admin\/dashboard$/, admin.getDashboard],
  ['PATCH', /^\/api\/admin\/settings$/, admin.patchSettings],
  ['POST', /^\/api\/admin\/start$/, admin.startEvent],
  ['POST', /^\/api\/admin\/roster$/, admin.addRoster],
  ['PATCH', /^\/api\/admin\/roster\/(\d+)$/, admin.patchRoster],
  ['DELETE', /^\/api\/admin\/roster\/(\d+)$/, admin.excludeRoster],
  ['POST', /^\/api\/admin\/roster\/(\d+)\/invite$/, admin.issueInvite],
  ['POST', /^\/api\/admin\/invites$/, admin.issueMissingInvites],
  ['POST', /^\/api\/admin\/participants\/(\d+)\/reset$/, admin.resetParticipant],
  ['POST', /^\/api\/admin\/participants\/(\d+)\/unsubmit$/, admin.unsubmitParticipant],
  ['POST', /^\/api\/admin\/participants\/(\d+)\/reissue-code$/, admin.reissueCode],
  ['POST', /^\/api\/admin\/match$/, admin.manualMatch],
  ['POST', /^\/api\/admin\/rematch$/, admin.rematchEvent],
  ['POST', /^\/api\/admin\/close$/, admin.closeEvent],
  ['POST', /^\/api\/admin\/reveal$/, admin.revealResults],
  ['DELETE', /^\/api\/admin\/data$/, admin.deleteData],
  ['POST', /^\/api\/admin\/new-event$/, admin.startNewEvent],
];

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH) {
      throw new HttpError(503, 'CONFIG_MISSING', '서버 설정이 완료되지 않았습니다. 운영자에게 문의해 주세요.');
    }
    // 상태를 바꾸는 요청은 같은 Origin 에서 온 것만 받는다(세션이 있는 요청은 CSRF 토큰도 검증).
    if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
      throw new HttpError(403, 'BAD_ORIGIN', '허용되지 않은 요청입니다.');
    }
    let pathMatched = false;
    for (const [method, pattern, handler] of ROUTES) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (method === request.method) return await handler(request, env, url, match.slice(1));
    }
    if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청입니다.');
    throw new HttpError(404, 'NOT_FOUND', '요청한 주소를 찾을 수 없습니다.');
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    // 목표·코드·토큰·매칭 내용이 로그에 남지 않도록 경로와 오류 메시지만 기록한다.
    console.error('api_error', request.method, url.pathname, error instanceof Error ? error.message : 'unknown');
    return errorResponse(new HttpError(500, 'INTERNAL', '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'));
  }
}

/** 매분 실행: 전원 확정 후 완료되지 못한 매칭을 재시도하고, 정각에는 만료 기록을 정리한다. */
export async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const event = await env.DB.prepare('SELECT status FROM event WHERE id = 1').first<{ status: string }>();
  if (event?.status === 'OPEN') {
    try {
      await tryAutoMatch(env.DB);
    } catch (error) {
      console.error('recovery_match_failed', error instanceof Error ? error.message : 'unknown');
    }
  }
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    const now = nowIso();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
      env.DB.prepare(
        'DELETE FROM auth_attempts WHERE window_start < ?1 AND (blocked_until IS NULL OR blocked_until <= ?2)',
      ).bind(dayAgo, now),
    ]);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env): Promise<void> {
    await runScheduled(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
