import type { AdminDashboard, AdminRosterRow, EventStatus, IssuedInvite, SubmitStatus } from '../../shared/types';
import { cleanBudgetNote, cleanEventName, cleanRosterName, LIMITS } from '../../shared/validation';
import {
  assertNotBlocked,
  clearFailures,
  clientIp,
  newSession,
  RATE_RULES,
  recordFailure,
  requireSession,
  scopeHash,
} from '../auth';
import { generateAccessCode, generateInviteCode, inviteHash, randomToken, sha256Hex, verifyPassword } from '../crypto';
import type { Env } from '../env';
import { loadEvent, selectEvent, toEventInfo, type EventRow } from '../eventStore';
import { HttpError, isUniqueViolation, json, nowIso, parsePositiveInt, readJsonBody } from '../http';
import { forceMatch, rematch, tryAutoMatch } from '../matchService';

const DELETE_DUE_DAYS = 7;
const STALE_MESSAGE = '현황이 바뀌었습니다. 새로 고친 내용을 확인한 뒤 다시 시도해 주세요.';

function requireAdmin(request: Request, env: Env) {
  return requireSession(request, env, 'admin', { csrf: true });
}

function expectedRevisionOf(body: Record<string, unknown>): number {
  const value = body.expectedRevision;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'INVALID_INPUT', '현황을 새로 고친 뒤 다시 시도해 주세요.');
  }
  return value;
}

// ---- 작업 소유권 ------------------------------------------------------------
//
// 관리자 변경은 첫 문장에서 상태·revision·대상 조건을 검사하며 event.op_token 에 이번 작업만의
// 토큰을 기록한다. 후속 문장은 모두 OWNED 조건을 달아, 첫 문장이 0행이면 아무것도 바꾸지 않는다.

const OWNED = 'EXISTS (SELECT 1 FROM event WHERE id = 1 AND op_token = ?)';

interface OwnedOp {
  statuses: EventStatus[];
  expectedRevision: number | null;
  /** 첫 문장에 덧붙일 조건과 바인딩 값 */
  condition?: { sql: string; binds: unknown[] };
  /** 첫 문장에 덧붙일 SET 절과 바인딩 값 */
  assign?: { sql: string; binds: unknown[] };
  /** 후속 문장. 각 SQL 은 OWNED 를 마지막 조건으로 포함하고 token 을 마지막에 바인딩한다. */
  followUps: (token: string) => D1PreparedStatement[];
}

async function runOwnedOp(env: Env, op: OwnedOp, now: string): Promise<boolean> {
  const token = randomToken();
  const statusList = op.statuses.map((status) => `'${status}'`).join(', ');
  const binds: unknown[] = [token, now, ...(op.assign?.binds ?? [])];
  let sql = `UPDATE event SET revision = revision + 1, op_token = ?, updated_at = ?${op.assign ? `, ${op.assign.sql}` : ''}
              WHERE id = 1 AND status IN (${statusList})`;
  if (op.expectedRevision !== null) {
    sql += ' AND revision = ?';
    binds.push(op.expectedRevision);
  }
  if (op.condition) {
    sql += ` AND (${op.condition.sql})`;
    binds.push(...op.condition.binds);
  }
  const results = await env.DB.batch([env.DB.prepare(sql).bind(...binds), ...op.followUps(token)]);
  return results[0]!.meta.changes === 1;
}

/** 소유권 획득 실패의 원인을 찾는다. 상태·revision 문제가 아니면 fallback 을 쓴다. */
async function ownedOpRejection(env: Env, op: Pick<OwnedOp, 'statuses' | 'expectedRevision'>, fallback: HttpError) {
  const event = await loadEvent(env.DB);
  if (!op.statuses.includes(event.status)) {
    return new HttpError(409, 'INVALID_STATE', '현재 행사 단계에서는 할 수 없는 작업입니다.');
  }
  if (op.expectedRevision !== null && event.revision !== op.expectedRevision) {
    return new HttpError(409, 'STALE', STALE_MESSAGE);
  }
  return fallback;
}

// ---- 로그인·현황 ------------------------------------------------------------

export async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const ipScope = await scopeHash(env, `admin:ip:${clientIp(request)}`);
  const globalScope = await scopeHash(env, 'admin:global');
  await assertNotBlocked(env, [ipScope, globalScope]);

  const body = await readJsonBody(request);
  const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : '';
  if (password === '' || !(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
    await recordFailure(env, ipScope, RATE_RULES.adminIp);
    await recordFailure(env, globalScope, RATE_RULES.adminGlobal);
    throw new HttpError(401, 'INVALID_PASSWORD', '비밀번호를 확인해 주세요.');
  }
  await clearFailures(env, ipScope);

  const session = await newSession(env, url, 'admin');
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, role, participant_id, credential_version, created_at, expires_at)
     VALUES (?1, 'admin', NULL, NULL, ?2, ?3)`,
  )
    .bind(session.tokenHash, session.createdAt, session.expiresAt)
    .run();
  return json({ csrfToken: session.csrfToken }, { cookies: [session.cookie] });
}

interface DashboardRow {
  id: number;
  display_name: string;
  active: number;
  invite_issued: number;
  participant_id: number | null;
  nickname: string | null;
  submit_status: SubmitStatus | null;
  submitted_at: string | null;
  viewed: number | null;
}

export async function getDashboard(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'admin', { csrf: false });
  const [eventResult, rosterResult] = await env.DB.batch([
    selectEvent(env.DB),
    // 운영 현황 전용 조회: 목표·코드·선물 번호·배정 상대는 선택하지 않는다.
    env.DB.prepare(
      `SELECT r.id, r.display_name, r.active, r.invite_hash IS NOT NULL AS invite_issued,
              p.id AS participant_id, p.nickname, p.submit_status, p.submitted_at,
              (SELECT a.viewed_at IS NOT NULL FROM assignments a
                 JOIN event e ON e.id = 1 AND e.match_run_id = a.match_run_id
                WHERE a.santa_id = p.id) AS viewed
         FROM roster r LEFT JOIN participants p ON p.roster_id = r.id
        ORDER BY r.active DESC, r.id`,
    ),
  ]);
  const event = eventResult!.results[0] as unknown as EventRow;
  const rows = rosterResult!.results as unknown as DashboardRow[];
  const roster: AdminRosterRow[] = rows.map((row) => ({
    id: row.id,
    name: row.display_name,
    active: row.active === 1,
    inviteIssued: row.invite_issued === 1,
    participant:
      row.participant_id === null
        ? null
        : {
            id: row.participant_id,
            nickname: row.nickname!,
            submitStatus: row.submit_status!,
            submittedAt: row.submitted_at,
            viewed: row.viewed === 1,
          },
  }));
  const activeRows = roster.filter((row) => row.active);
  const deleteBase = event.status === 'CLOSED' ? (event.revealed_at ?? event.closed_at) : null;
  const dashboard: AdminDashboard = {
    event: {
      ...toEventInfo(event),
      revision: event.revision,
      matchedAt: event.matched_at,
      closedAt: event.closed_at,
      revealedAt: event.revealed_at,
      deletedAt: event.deleted_at,
      deleteDueAt: deleteBase
        ? new Date(Date.parse(deleteBase) + DELETE_DUE_DAYS * 24 * 60 * 60 * 1000).toISOString()
        : null,
    },
    counts: {
      active: activeRows.length,
      registered: activeRows.filter((row) => row.participant).length,
      submitted: activeRows.filter((row) => row.participant?.submitStatus === 'SUBMITTED').length,
      viewed: activeRows.filter((row) => row.participant?.viewed).length,
    },
    roster,
    csrfToken: session.csrfToken,
  };
  return json(dashboard);
}

// ---- 설정·참여 시작 ---------------------------------------------------------

export async function patchSettings(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJsonBody(request);
  const name = cleanEventName(body.name);
  if (!name.ok) throw new HttpError(400, 'INVALID_INPUT', name.message);
  const budget = cleanBudgetNote(body.budgetNote ?? '');
  if (!budget.ok) throw new HttpError(400, 'INVALID_INPUT', budget.message);
  const deadlineTime = typeof body.deadlineAt === 'string' ? Date.parse(body.deadlineAt) : NaN;
  if (Number.isNaN(deadlineTime)) throw new HttpError(400, 'INVALID_INPUT', '마감 일시를 입력해 주세요.');
  const deadlineAt = new Date(deadlineTime).toISOString();

  const now = nowIso();
  // 마감은 미래 시각이어야 한다. 이미 저장된 값을 그대로 두는 경우만 예외다.
  const result = await env.DB.prepare(
    `UPDATE event SET name = ?1, budget_note = ?2, deadline_at = ?3, updated_at = ?4
      WHERE id = 1 AND status IN ('SETUP', 'OPEN') AND (?3 > ?4 OR deadline_at = ?3)`,
  )
    .bind(name.value, budget.value, deadlineAt, now)
    .run();
  if (result.meta.changes !== 1) {
    const event = await loadEvent(env.DB);
    if (event.status !== 'SETUP' && event.status !== 'OPEN') {
      throw new HttpError(409, 'INVALID_STATE', '매칭 이후에는 행사 설정을 바꿀 수 없습니다.');
    }
    throw new HttpError(400, 'INVALID_INPUT', '마감은 현재 시각 이후로 설정해 주세요.');
  }
  return json({ ok: true });
}

export async function startEvent(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJsonBody(request);
  const expectedRevision = expectedRevisionOf(body);
  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['SETUP'],
    expectedRevision,
    assign: { sql: `status = 'OPEN'`, binds: [] },
    condition: {
      sql: `name <> '' AND deadline_at IS NOT NULL AND deadline_at > ?
            AND (SELECT COUNT(*) FROM roster WHERE active = 1) BETWEEN ${LIMITS.rosterMin} AND ${LIMITS.rosterMax}`,
      binds: [now],
    },
    followUps: () => [],
  };
  if (!(await runOwnedOp(env, op, now))) {
    const event = await loadEvent(env.DB);
    if (event.status === 'OPEN') return json({ ok: true }); // 재전송
    throw await ownedOpRejection(
      env,
      op,
      new HttpError(409, 'NOT_READY', `행사명, 미래의 마감 일시, 활성 명단 ${LIMITS.rosterMin}~${LIMITS.rosterMax}명이 필요합니다.`),
    );
  }
  return json({ ok: true });
}

// ---- 명단 -------------------------------------------------------------------

export async function addRoster(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJsonBody(request);
  const expectedRevision = expectedRevisionOf(body);
  if (!Array.isArray(body.names) || body.names.length === 0 || body.names.length > LIMITS.rosterMax) {
    throw new HttpError(400, 'INVALID_INPUT', `이름을 1~${LIMITS.rosterMax}개 입력해 주세요.`);
  }
  const entries: { d: string; n: string }[] = [];
  const seen = new Set<string>();
  for (const raw of body.names) {
    const cleaned = cleanRosterName(raw);
    if (!cleaned.ok) throw new HttpError(400, 'INVALID_INPUT', cleaned.message);
    if (seen.has(cleaned.value.normalized)) {
      throw new HttpError(400, 'DUPLICATE_NAME', `입력한 목록에 같은 이름이 있습니다: ${cleaned.value.displayName}`);
    }
    seen.add(cleaned.value.normalized);
    entries.push({ d: cleaned.value.displayName, n: cleaned.value.normalized });
  }
  const payload = JSON.stringify(entries);

  const capacityOrDuplicateError = async () => {
    const { results } = await env.DB.prepare(
      `SELECT display_name, active FROM roster
        WHERE normalized_name IN (SELECT json_extract(value, '$.n') FROM json_each(?1))`,
    )
      .bind(payload)
      .all<{ display_name: string; active: number }>();
    if (results.length === 0) return new HttpError(409, 'ROSTER_FULL', `명단은 최대 ${LIMITS.rosterMax}명입니다.`);
    const names = results.map((row) => (row.active === 1 ? row.display_name : `${row.display_name}(제외됨)`)).join(', ');
    return new HttpError(409, 'DUPLICATE_NAME', `이미 명단에 있는 이름입니다: ${names}. 동명이인은 '민수 A'처럼 구분해 주세요.`);
  };

  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['SETUP', 'OPEN'],
    expectedRevision,
    condition: {
      sql: `(SELECT COUNT(*) FROM roster WHERE active = 1) + ? <= ${LIMITS.rosterMax}
            AND NOT EXISTS (SELECT 1 FROM roster WHERE normalized_name IN (SELECT json_extract(value, '$.n') FROM json_each(?)))`,
      binds: [entries.length, payload],
    },
    followUps: (token) => [
      env.DB.prepare(
        `INSERT INTO roster (display_name, normalized_name, active, created_at)
         SELECT json_extract(j.value, '$.d'), json_extract(j.value, '$.n'), 1, ?
           FROM json_each(?) AS j
          WHERE ${OWNED}`,
      ).bind(now, payload, token),
    ],
  };
  try {
    if (!(await runOwnedOp(env, op, now))) {
      throw await ownedOpRejection(env, op, await capacityOrDuplicateError());
    }
  } catch (error) {
    // 사전 조건을 통과한 뒤 UNIQUE 제약에 걸린 경우(batch 전체 롤백)
    if (isUniqueViolation(error, 'roster.normalized_name')) throw await capacityOrDuplicateError();
    throw error;
  }
  return json({ ok: true, added: entries.length }, { status: 201 });
}

/** 등록되지 않은 이름의 변경, 또는 제외된 이름의 복원. */
export async function patchRoster(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const rosterId = parsePositiveInt(params[0]);
  if (rosterId === null) throw new HttpError(404, 'NOT_FOUND', '명단에서 찾을 수 없습니다.');
  const body = await readJsonBody(request);
  const expectedRevision = expectedRevisionOf(body);
  const now = nowIso();

  if (body.active === true) {
    const op: OwnedOp = {
      statuses: ['SETUP', 'OPEN'],
      expectedRevision,
      condition: {
        sql: `EXISTS (SELECT 1 FROM roster WHERE id = ? AND active = 0)
              AND (SELECT COUNT(*) FROM roster WHERE active = 1) < ${LIMITS.rosterMax}`,
        binds: [rosterId],
      },
      followUps: (token) => [
        env.DB.prepare(`UPDATE roster SET active = 1 WHERE id = ? AND active = 0 AND ${OWNED}`).bind(rosterId, token),
      ],
    };
    if (!(await runOwnedOp(env, op, now))) {
      throw await ownedOpRejection(env, op, new HttpError(409, 'CONFLICT', '복원할 수 없는 이름입니다.'));
    }
    return json({ ok: true });
  }

  const cleaned = cleanRosterName(body.displayName);
  if (!cleaned.ok) throw new HttpError(400, 'INVALID_INPUT', cleaned.message);
  const op: OwnedOp = {
    statuses: ['SETUP', 'OPEN'],
    expectedRevision,
    condition: {
      sql: `EXISTS (SELECT 1 FROM roster WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = ?)`,
      binds: [rosterId, rosterId],
    },
    followUps: (token) => [
      env.DB.prepare(
        `UPDATE roster SET display_name = ?, normalized_name = ?
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = roster.id) AND ${OWNED}`,
      ).bind(cleaned.value.displayName, cleaned.value.normalized, rosterId, token),
    ],
  };
  try {
    if (!(await runOwnedOp(env, op, now))) {
      throw await ownedOpRejection(
        env,
        op,
        new HttpError(409, 'REGISTERED', '이미 등록한 사람의 이름은 바꿀 수 없습니다. 등록 초기화 후 변경해 주세요.'),
      );
    }
  } catch (error) {
    if (isUniqueViolation(error, 'roster.normalized_name')) {
      throw new HttpError(409, 'DUPLICATE_NAME', '이미 명단에 있는 이름입니다.');
    }
    throw error;
  }
  return json({ ok: true });
}

/** 명단 제외. 미확정자의 닉네임·임시 목표·접속 권한도 함께 삭제한다. 확정 제출자는 거부한다. */
export async function excludeRoster(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const rosterId = parsePositiveInt(params[0]);
  if (rosterId === null) throw new HttpError(404, 'NOT_FOUND', '명단에서 찾을 수 없습니다.');
  const body = await readJsonBody(request);
  const expectedRevision = expectedRevisionOf(body);
  const now = nowIso();

  // 이미 제외된 이름을 명단에서 완전히 지운다(오타 정리용). 등록 정보가 없는 행만 해당한다.
  if (body.permanent === true) {
    const removal: OwnedOp = {
      statuses: ['SETUP', 'OPEN'],
      expectedRevision,
      condition: {
        sql: `EXISTS (SELECT 1 FROM roster WHERE id = ? AND active = 0)
              AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = ?)`,
        binds: [rosterId, rosterId],
      },
      followUps: (token) => [
        env.DB.prepare(
          `DELETE FROM roster
            WHERE id = ? AND active = 0 AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = roster.id) AND ${OWNED}`,
        ).bind(rosterId, token),
      ],
    };
    if (!(await runOwnedOp(env, removal, now))) {
      throw await ownedOpRejection(env, removal, new HttpError(409, 'CONFLICT', '먼저 명단에서 제외한 이름만 삭제할 수 있습니다.'));
    }
    return json({ ok: true, eventStatus: null });
  }

  const op: OwnedOp = {
    statuses: ['SETUP', 'OPEN'],
    expectedRevision,
    condition: {
      sql: `EXISTS (SELECT 1 FROM roster WHERE id = ? AND active = 1)
            AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = ? AND submit_status = 'SUBMITTED')`,
      binds: [rosterId, rosterId],
    },
    followUps: (token) => [
      env.DB.prepare(
        `DELETE FROM sessions WHERE participant_id IN (SELECT id FROM participants WHERE roster_id = ?) AND ${OWNED}`,
      ).bind(rosterId, token),
      env.DB.prepare(`DELETE FROM participants WHERE roster_id = ? AND submit_status = 'DRAFT' AND ${OWNED}`).bind(
        rosterId,
        token,
      ),
      env.DB.prepare(`UPDATE roster SET active = 0 WHERE id = ? AND ${OWNED}`).bind(rosterId, token),
    ],
  };
  if (!(await runOwnedOp(env, op, now))) {
    throw await ownedOpRejection(
      env,
      op,
      new HttpError(409, 'SUBMITTED', '확정 제출한 사람은 제외할 수 없습니다. 먼저 확정을 해제해 주세요.'),
    );
  }
  return json({ ok: true, eventStatus: await matchAfterChange(env) });
}

/** 명단 변경으로 전원 확정 상태가 되었을 수 있으므로 자동 매칭을 시도한다. */
async function matchAfterChange(env: Env): Promise<EventStatus | null> {
  try {
    return await tryAutoMatch(env.DB);
  } catch (error) {
    console.error('auto_match_failed', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

// ---- 참여 비밀번호 -----------------------------------------------------------
//
// 명단의 사람마다 무작위 비밀번호를 발급한다. 원문은 이 응답에서만 내려가고 DB 에는 HMAC 만 남는다.
// 관리자가 본인에게 직접 전달하며, 참여 등록 때 이름과 함께 입력해야 한다.

const CAN_ISSUE = `active = 1
  AND NOT EXISTS (SELECT 1 FROM participants WHERE roster_id = roster.id)
  AND EXISTS (SELECT 1 FROM event WHERE id = 1 AND status IN ('SETUP', 'OPEN'))`;

/** 한 사람의 참여 비밀번호 발급·재발급. 이전에 발급한 비밀번호는 즉시 무효가 된다. */
export async function issueInvite(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const rosterId = parsePositiveInt(params[0]);
  if (rosterId === null) throw new HttpError(404, 'NOT_FOUND', '명단에서 찾을 수 없습니다.');
  const inviteCode = generateInviteCode();
  const row = await env.DB.prepare(`UPDATE roster SET invite_hash = ?1 WHERE id = ?2 AND ${CAN_ISSUE} RETURNING display_name`)
    .bind(await inviteHash(env.SESSION_SECRET, rosterId, inviteCode), rosterId)
    .first<{ display_name: string }>();
  if (!row) {
    throw new HttpError(409, 'CONFLICT', '참여 비밀번호는 준비·참여 단계에서, 아직 등록하지 않은 활성 명단에만 발급할 수 있습니다.');
  }
  const issued: IssuedInvite = { rosterId, name: row.display_name, inviteCode };
  return json({ invites: [issued] });
}

/** 아직 발급받지 않은 미등록자 전원에게 한 번에 발급한다. 이미 발급된 비밀번호는 바꾸지 않는다. */
export async function issueMissingInvites(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { results: candidates } = await env.DB.prepare(
    `SELECT id, display_name FROM roster WHERE invite_hash IS NULL AND ${CAN_ISSUE} ORDER BY id`,
  ).all<{ id: number; display_name: string }>();
  const prepared = await Promise.all(
    candidates.map(async (row) => {
      const inviteCode = generateInviteCode();
      return { id: row.id, name: row.display_name, inviteCode, h: await inviteHash(env.SESSION_SECRET, row.id, inviteCode) };
    }),
  );
  if (prepared.length === 0) return json({ invites: [] });
  // 한 문장으로 저장하고, 실제로 반영된 행의 비밀번호만 돌려준다(그 사이 발급·등록된 사람 제외).
  const { results: updated } = await env.DB.prepare(
    `UPDATE roster
        SET invite_hash = (SELECT json_extract(j.value, '$.h') FROM json_each(?1) AS j WHERE json_extract(j.value, '$.id') = roster.id)
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1)) AND invite_hash IS NULL AND ${CAN_ISSUE}
      RETURNING id`,
  )
    .bind(JSON.stringify(prepared.map(({ id, h }) => ({ id, h }))))
    .all<{ id: number }>();
  const saved = new Set(updated.map((row) => row.id));
  const invites: IssuedInvite[] = prepared
    .filter((item) => saved.has(item.id))
    .map((item) => ({ rosterId: item.id, name: item.name, inviteCode: item.inviteCode }));
  return json({ invites });
}

// ---- 참여자 운영 ------------------------------------------------------------

function participantIdOf(params: string[]): number {
  const id = parsePositiveInt(params[0]);
  if (id === null) throw new HttpError(404, 'NOT_FOUND', '참여자를 찾을 수 없습니다.');
  return id;
}

export async function resetParticipant(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const participantId = participantIdOf(params);
  const expectedRevision = expectedRevisionOf(await readJsonBody(request));
  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['OPEN'],
    expectedRevision,
    condition: { sql: 'EXISTS (SELECT 1 FROM participants WHERE id = ?)', binds: [participantId] },
    followUps: (token) => [
      env.DB.prepare(`DELETE FROM sessions WHERE participant_id = ? AND ${OWNED}`).bind(participantId, token),
      env.DB.prepare(`DELETE FROM participants WHERE id = ? AND ${OWNED}`).bind(participantId, token),
    ],
  };
  if (!(await runOwnedOp(env, op, now))) {
    throw await ownedOpRejection(env, op, new HttpError(404, 'NOT_FOUND', '참여자를 찾을 수 없습니다.'));
  }
  return json({ ok: true });
}

export async function unsubmitParticipant(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const participantId = participantIdOf(params);
  const expectedRevision = expectedRevisionOf(await readJsonBody(request));
  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['OPEN'],
    expectedRevision,
    condition: {
      sql: `EXISTS (SELECT 1 FROM participants WHERE id = ? AND submit_status = 'SUBMITTED')`,
      binds: [participantId],
    },
    followUps: (token) => [
      env.DB.prepare(
        `UPDATE participants SET submit_status = 'DRAFT', submitted_at = NULL, updated_at = ?
          WHERE id = ? AND submit_status = 'SUBMITTED' AND ${OWNED}`,
      ).bind(now, participantId, token),
    ],
  };
  if (!(await runOwnedOp(env, op, now))) {
    throw await ownedOpRejection(env, op, new HttpError(409, 'CONFLICT', '확정 제출 상태가 아닙니다.'));
  }
  return json({ ok: true });
}

/** 새 코드 발급. credential_version 증가와 기존 세션 삭제를 한 트랜잭션으로 처리한다. */
export async function reissueCode(request: Request, env: Env, _url: URL, params: string[]): Promise<Response> {
  await requireAdmin(request, env);
  const participantId = participantIdOf(params);
  const accessCode = generateAccessCode();
  const codeHash = await sha256Hex(accessCode);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE participants SET code_hash = ?1, credential_version = credential_version + 1, updated_at = ?3
        WHERE id = ?2`,
    ).bind(codeHash, participantId, nowIso()),
    // 새 code_hash 는 이 요청만 아는 값이므로 소유권 조건으로 쓴다.
    env.DB.prepare(
      `DELETE FROM sessions
        WHERE participant_id = ?2 AND EXISTS (SELECT 1 FROM participants WHERE id = ?2 AND code_hash = ?1)`,
    ).bind(codeHash, participantId),
  ]);
  if (results[0]!.meta.changes !== 1) throw new HttpError(404, 'NOT_FOUND', '참여자를 찾을 수 없습니다.');
  return json({ accessCode });
}

// ---- 매칭·종료·공개·삭제 ----------------------------------------------------

export async function manualMatch(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const expectedRevision = expectedRevisionOf(await readJsonBody(request));
  await forceMatch(env.DB, expectedRevision);
  return json({ ok: true });
}

export async function rematchEvent(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  await rematch(env.DB);
  return json({ ok: true });
}

export async function closeEvent(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE event SET status = 'CLOSED', closed_at = ?1, updated_at = ?1, revision = revision + 1
      WHERE id = 1 AND status = 'MATCHED'`,
  )
    .bind(now)
    .run();
  if (result.meta.changes !== 1) {
    const event = await loadEvent(env.DB);
    if (event.status !== 'CLOSED') {
      throw new HttpError(409, 'INVALID_STATE', '매칭이 완료된 뒤에만 행사를 종료할 수 있습니다.');
    }
  }
  return json({ ok: true });
}

export async function revealResults(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE event SET revealed_at = ?1, updated_at = ?1 WHERE id = 1 AND status = 'CLOSED' AND revealed_at IS NULL`,
  )
    .bind(now)
    .run();
  if (result.meta.changes !== 1) {
    const event = await loadEvent(env.DB);
    if (event.status !== 'CLOSED' || !event.revealed_at) {
      throw new HttpError(409, 'INVALID_STATE', '행사를 종료한 뒤에만 결과를 공개할 수 있습니다.');
    }
  }
  return json({ ok: true });
}

/**
 * 삭제가 끝난 뒤 새 행사를 준비 상태(SETUP)로 연다. 이전 행사의 데이터는 이미 지워져 있으며,
 * 혹시 남은 행이 있더라도 같은 트랜잭션에서 비운다. 이전 접속 코드·참여자 세션은 되살아나지 않는다.
 */
export async function startNewEvent(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['DELETED'],
    expectedRevision: null,
    assign: { sql: `status = 'SETUP', deleted_at = NULL`, binds: [] },
    followUps: (token) =>
      [
        'DELETE FROM assignments',
        'DELETE FROM gift_numbers',
        `DELETE FROM sessions WHERE role = 'participant' AND ${OWNED}`,
        'DELETE FROM participants',
        'DELETE FROM roster',
      ].map((sql) => env.DB.prepare(sql.includes(OWNED) ? sql : `${sql} WHERE ${OWNED}`).bind(token)),
  };
  if (!(await runOwnedOp(env, op, now))) {
    const event = await loadEvent(env.DB);
    if (event.status === 'SETUP') return json({ ok: true }); // 재전송
    throw new HttpError(409, 'INVALID_STATE', '데이터 삭제를 마친 뒤에만 새 행사를 시작할 수 있습니다.');
  }
  return json({ ok: true });
}

/** 개인정보 삭제 후 DELETED 전환. 확인을 위해 행사명을 그대로 입력받는다. */
export async function deleteData(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJsonBody(request);
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
  const now = nowIso();
  const op: OwnedOp = {
    statuses: ['CLOSED'],
    expectedRevision: null,
    assign: {
      sql: `status = 'DELETED', deleted_at = ?, name = '', budget_note = '', deadline_at = NULL,
            match_run_id = NULL, matched_at = NULL, closed_at = NULL, revealed_at = NULL`,
      binds: [now],
    },
    condition: { sql: `name = ? AND name <> ''`, binds: [confirmName] },
    followUps: (token) =>
      [
        'DELETE FROM assignments',
        'DELETE FROM gift_numbers',
        `DELETE FROM sessions WHERE role = 'participant' AND ${OWNED}`,
        'DELETE FROM participants',
        'DELETE FROM roster',
        'DELETE FROM auth_attempts',
      ].map((sql) => env.DB.prepare(sql.includes(OWNED) ? sql : `${sql} WHERE ${OWNED}`).bind(token)),
  };
  if (!(await runOwnedOp(env, op, now))) {
    const event = await loadEvent(env.DB);
    if (event.status === 'DELETED') return json({ ok: true }); // 재전송
    throw await ownedOpRejection(
      env,
      op,
      new HttpError(400, 'CONFIRM_MISMATCH', '확인을 위해 행사명을 정확히 입력해 주세요.'),
    );
  }
  return json({ ok: true });
}
