import type { RegisterResponse, ResultPair, RosterOption } from '../../shared/types';
import { cleanGoal, cleanNickname, normalizeAccessCode, normalizeInviteCode } from '../../shared/validation';
import {
  assertNotBlocked,
  clearedCookie,
  clientIp,
  loadSession,
  newSession,
  RATE_RULES,
  recordFailure,
  requireSession,
  scopeHash,
  type Role,
} from '../auth';
import { generateAccessCode, inviteHash, sha256Hex } from '../crypto';
import type { Env } from '../env';
import { isPastDeadline, loadEvent, toEventInfo } from '../eventStore';
import { HttpError, isUniqueViolation, json, nowIso, parsePositiveInt, readJsonBody } from '../http';

export async function getEvent(_request: Request, env: Env): Promise<Response> {
  return json(toEventInfo(await loadEvent(env.DB)));
}

/** 참여 시작 후에만 명단을 제공한다. 이름과 등록 가능 여부 외에는 내려주지 않는다. */
export async function getRoster(_request: Request, env: Env): Promise<Response> {
  const event = await loadEvent(env.DB);
  if (event.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
  if (event.status !== 'OPEN') throw new HttpError(409, 'NOT_OPEN', '지금은 참여 등록 기간이 아닙니다.');
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.display_name AS name, p.id IS NULL AS available
       FROM roster r LEFT JOIN participants p ON p.roster_id = r.id
      WHERE r.active = 1
      ORDER BY r.display_name COLLATE NOCASE`,
  ).all<{ id: number; name: string; available: number }>();
  const roster: RosterOption[] = results.map((row) => ({ id: row.id, name: row.name, available: row.available === 1 }));
  return json({ roster });
}

/**
 * 참여 등록. 명단에서 고른 이름에 대해 관리자가 발급·전달한 참여 비밀번호가 맞아야 등록된다.
 * 비밀번호는 등록에 쓰이는 즉시 폐기되어 다시 사용할 수 없다.
 */
export async function registerParticipant(request: Request, env: Env, url: URL): Promise<Response> {
  const ipScope = await scopeHash(env, `register:ip:${clientIp(request)}`);
  await assertNotBlocked(env, [ipScope]);
  const body = await readJsonBody(request);
  const rosterId = parsePositiveInt(body.rosterId);
  if (rosterId === null) throw new HttpError(400, 'INVALID_INPUT', '명단에서 본인 이름을 선택해 주세요.');
  const nickname = cleanNickname(body.nickname);
  if (!nickname.ok) throw new HttpError(400, 'INVALID_NICKNAME', nickname.message);
  const goal = cleanGoal(body.goalText ?? '', { allowEmpty: true });
  if (!goal.ok) throw new HttpError(400, 'INVALID_GOAL', goal.message);

  // 형식이 틀린 비밀번호는 어떤 저장 값과도 일치하지 않는 값으로 바꿔 같은 경로로 거부한다.
  const inviteCode = normalizeInviteCode(body.inviteCode);
  const expectedInvite = inviteCode === null ? '' : await inviteHash(env.SESSION_SECRET, rosterId, inviteCode);

  const accessCode = generateAccessCode();
  const codeHash = await sha256Hex(accessCode);
  const session = await newSession(env, url, 'participant');
  const now = nowIso();

  let results: D1Result[];
  try {
    // code_hash 는 이 요청만 아는 고유 값이므로 후속 문장의 소유권 조건으로 쓴다.
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO participants
           (roster_id, nickname, normalized_nickname, goal_text, submit_status, code_hash, credential_version, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, 'DRAFT', ?5, 1, ?6, ?6
          WHERE EXISTS (SELECT 1 FROM event WHERE id = 1 AND status = 'OPEN' AND deadline_at > ?6)
            AND EXISTS (SELECT 1 FROM roster WHERE id = ?1 AND active = 1 AND invite_hash IS NOT NULL AND invite_hash = ?7)`,
      ).bind(rosterId, nickname.value.nickname, nickname.value.normalized, goal.value, codeHash, now, expectedInvite),
      // 사용한 참여 비밀번호는 폐기한다(등록 초기화 후에는 새로 발급받아야 한다).
      env.DB.prepare(
        `UPDATE roster SET invite_hash = NULL
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM participants WHERE code_hash = ?2 AND roster_id = ?1)`,
      ).bind(rosterId, codeHash),
      env.DB.prepare(
        `UPDATE event SET revision = revision + 1, updated_at = ?2
          WHERE id = 1 AND status = 'OPEN' AND EXISTS (SELECT 1 FROM participants WHERE code_hash = ?1)`,
      ).bind(codeHash, now),
      env.DB.prepare(
        `INSERT INTO sessions (token_hash, role, participant_id, credential_version, created_at, expires_at)
         SELECT ?1, 'participant', id, credential_version, ?2, ?3 FROM participants WHERE code_hash = ?4`,
      ).bind(session.tokenHash, session.createdAt, session.expiresAt, codeHash),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, 'participants.roster_id')) {
      throw new HttpError(409, 'NAME_TAKEN', '이미 등록된 이름입니다. 본인이 등록했다면 접속 코드로 재접속해 주세요.');
    }
    if (isUniqueViolation(error, 'participants.normalized_nickname')) {
      throw new HttpError(409, 'NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.');
    }
    throw error;
  }

  if (results[0]!.meta.changes !== 1) {
    const event = await loadEvent(env.DB);
    if (event.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
    if (event.status !== 'OPEN') throw new HttpError(409, 'NOT_OPEN', '지금은 참여 등록 기간이 아닙니다.');
    if (isPastDeadline(event, now)) throw new HttpError(409, 'DEADLINE_PASSED', '목표 작성이 마감되었습니다.');
    const roster = await env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM participants WHERE roster_id = r.id) AS registered
         FROM roster r WHERE r.id = ?1 AND r.active = 1`,
    )
      .bind(rosterId)
      .first<{ registered: number }>();
    if (!roster) throw new HttpError(409, 'NAME_UNAVAILABLE', '선택한 이름을 사용할 수 없습니다. 명단을 새로 고쳐 주세요.');
    if (roster.registered === 1) {
      throw new HttpError(409, 'NAME_TAKEN', '이미 등록된 이름입니다. 본인이 등록했다면 접속 코드로 재접속해 주세요.');
    }
    // 미발급과 불일치를 구분해 알려주지 않는다. 실패는 IP 기준으로 누적해 제한한다.
    await recordFailure(env, ipScope, RATE_RULES.registerIp);
    throw new HttpError(403, 'INVALID_INVITE', '참여 비밀번호가 맞지 않습니다. 주최자에게 받은 비밀번호와 선택한 이름을 확인해 주세요.');
  }

  const response: RegisterResponse = { accessCode, csrfToken: session.csrfToken };
  return json(response, { status: 201, cookies: [session.cookie] });
}

export async function accessWithCode(request: Request, env: Env, url: URL): Promise<Response> {
  const ipScope = await scopeHash(env, `access:ip:${clientIp(request)}`);
  await assertNotBlocked(env, [ipScope]);

  const body = await readJsonBody(request);
  const code = normalizeAccessCode(body.code);
  const session = await newSession(env, url, 'participant');
  let created = false;
  if (code !== null) {
    // 코드가 그 사이 재발급되면 code_hash 조건이 맞지 않아 세션이 만들어지지 않는다.
    const result = await env.DB.prepare(
      `INSERT INTO sessions (token_hash, role, participant_id, credential_version, created_at, expires_at)
       SELECT ?1, 'participant', id, credential_version, ?2, ?3 FROM participants WHERE code_hash = ?4`,
    )
      .bind(session.tokenHash, session.createdAt, session.expiresAt, await sha256Hex(code))
      .run();
    created = result.meta.changes === 1;
  }
  if (!created) {
    await recordFailure(env, ipScope, RATE_RULES.accessIp);
    const event = await loadEvent(env.DB);
    if (event.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
    throw new HttpError(401, 'INVALID_CODE', '접속 코드를 확인해 주세요.');
  }
  return json({ csrfToken: session.csrfToken }, { cookies: [session.cookie] });
}

export async function logout(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const role: Role | null = body.role === 'admin' || body.role === 'participant' ? body.role : null;
  if (!role) throw new HttpError(400, 'INVALID_INPUT', '요청 형식이 올바르지 않습니다.');
  const session = await requireSession(request, env, role, { csrf: true });
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(session.tokenHash).run();
  return json({ ok: true }, { cookies: [clearedCookie(url, role)] });
}

/** 공개 결과. 닉네임 두 개만 조회·직렬화한다(목표·명단 이름 제외). */
export async function getResults(request: Request, env: Env): Promise<Response> {
  const session = (await loadSession(request, env, 'participant')) ?? (await loadSession(request, env, 'admin'));
  const event = await loadEvent(env.DB);
  if (event.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', '접속 코드로 접속한 뒤 확인할 수 있습니다.');
  if (event.status !== 'CLOSED' || !event.revealed_at) {
    throw new HttpError(403, 'NOT_REVEALED', '아직 전체 결과가 공개되지 않았습니다.');
  }
  const { results } = await env.DB.prepare(
    `SELECT sp.nickname AS santaNickname, rp.nickname AS receiverNickname
       FROM assignments a
       JOIN event e ON e.id = 1 AND e.status = 'CLOSED' AND e.revealed_at IS NOT NULL AND e.match_run_id = a.match_run_id
       JOIN participants sp ON sp.id = a.santa_id
       JOIN participants rp ON rp.id = a.receiver_id
      ORDER BY sp.normalized_nickname`,
  ).all<ResultPair>();
  return json({ eventName: event.name, pairs: results });
}
