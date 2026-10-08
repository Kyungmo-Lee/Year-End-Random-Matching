import type { AssignmentView, MeResponse, SubmitResponse, SubmitStatus } from '../../shared/types';
import { cleanGoal, cleanNickname } from '../../shared/validation';
import { requireSession } from '../auth';
import type { Env } from '../env';
import { isPastDeadline, loadEvent, selectEvent, toEventInfo, type EventRow } from '../eventStore';
import { HttpError, isUniqueViolation, json, nowIso, readJsonBody } from '../http';
import { tryAutoMatch } from '../matchService';

interface OwnRow {
  nickname: string;
  goal_text: string;
  submit_status: SubmitStatus;
  roster_name: string;
  viewed_at: string | null;
}

export async function getMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'participant', { csrf: false });
  const [eventResult, ownResult] = await env.DB.batch([
    selectEvent(env.DB),
    // 본인 정보와 "현재 배정을 열람했는가" 만 조회한다. 상대 정보는 열람 API 에서만 내려준다.
    env.DB.prepare(
      `SELECT p.nickname, p.goal_text, p.submit_status, r.display_name AS roster_name,
              (SELECT a.viewed_at FROM assignments a
                 JOIN event e ON e.id = 1 AND e.match_run_id = a.match_run_id
                WHERE a.santa_id = p.id) AS viewed_at
         FROM participants p JOIN roster r ON r.id = p.roster_id
        WHERE p.id = ?1`,
    ).bind(session.participantId),
  ]);
  const own = ownResult!.results[0] as unknown as OwnRow | undefined;
  if (!own) throw new HttpError(401, 'UNAUTHENTICATED', '접속 코드로 다시 접속해 주세요.');
  const response: MeResponse = {
    event: toEventInfo(eventResult!.results[0] as unknown as EventRow),
    rosterName: own.roster_name,
    nickname: own.nickname,
    goalText: own.goal_text,
    submitStatus: own.submit_status,
    assignmentViewed: own.viewed_at !== null,
    csrfToken: session.csrfToken,
  };
  return json(response);
}

/** 수정·제출이 조건에 걸렸을 때 이유를 찾아 알맞은 오류를 만든다. */
async function editRejection(env: Env, participantId: number, now: string): Promise<HttpError> {
  const event = await loadEvent(env.DB);
  if (event.status === 'DELETED') return new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
  if (event.status !== 'OPEN') return new HttpError(409, 'NOT_OPEN', '지금은 수정할 수 없는 단계입니다.');
  if (isPastDeadline(event, now)) {
    return new HttpError(409, 'DEADLINE_PASSED', '마감되었습니다. 수정이 필요하면 주최자에게 마감 연장을 요청해 주세요.');
  }
  const own = await env.DB.prepare('SELECT submit_status FROM participants WHERE id = ?1')
    .bind(participantId)
    .first<{ submit_status: SubmitStatus }>();
  if (!own) return new HttpError(401, 'UNAUTHENTICATED', '접속 코드로 다시 접속해 주세요.');
  if (own.submit_status === 'SUBMITTED') {
    return new HttpError(409, 'ALREADY_SUBMITTED', '확정 제출 후에는 수정할 수 없습니다.');
  }
  return new HttpError(409, 'CONFLICT', '저장하지 못했습니다. 새로 고침 후 다시 시도해 주세요.');
}

const EDITABLE = `submit_status = 'DRAFT'
  AND EXISTS (SELECT 1 FROM event WHERE id = 1 AND status = 'OPEN' AND deadline_at > ?2)`;

export async function patchGoal(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'participant', { csrf: true });
  const body = await readJsonBody(request);
  const goal = cleanGoal(body.goalText, { allowEmpty: true });
  if (!goal.ok) throw new HttpError(400, 'INVALID_GOAL', goal.message);
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE participants SET goal_text = ?3, updated_at = ?2 WHERE id = ?1 AND ${EDITABLE}`,
  )
    .bind(session.participantId, now, goal.value)
    .run();
  if (result.meta.changes !== 1) throw await editRejection(env, session.participantId!, now);
  return json({ goalText: goal.value });
}

export async function patchNickname(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'participant', { csrf: true });
  const body = await readJsonBody(request);
  const nickname = cleanNickname(body.nickname);
  if (!nickname.ok) throw new HttpError(400, 'INVALID_NICKNAME', nickname.message);
  const now = nowIso();
  let result: D1Result;
  try {
    result = await env.DB.prepare(
      `UPDATE participants SET nickname = ?3, normalized_nickname = ?4, updated_at = ?2 WHERE id = ?1 AND ${EDITABLE}`,
    )
      .bind(session.participantId, now, nickname.value.nickname, nickname.value.normalized)
      .run();
  } catch (error) {
    if (isUniqueViolation(error, 'participants.normalized_nickname')) {
      throw new HttpError(409, 'NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.');
    }
    throw error;
  }
  if (result.meta.changes !== 1) throw await editRejection(env, session.participantId!, now);
  return json({ nickname: nickname.value.nickname });
}

/**
 * 확정 제출. 화면에서 확인한 닉네임·목표가 저장된 값과 같을 때만 잠근다.
 * 제출 저장과 매칭 시도는 별개이며, 매칭이 실패해도 제출은 유지된다.
 */
export async function submit(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'participant', { csrf: true });
  const participantId = session.participantId!;
  const body = await readJsonBody(request);
  const nickname = cleanNickname(body.nickname);
  if (!nickname.ok) throw new HttpError(400, 'INVALID_NICKNAME', nickname.message);
  const goal = cleanGoal(body.goalText, { allowEmpty: false });
  if (!goal.ok) throw new HttpError(400, 'INVALID_GOAL', goal.message);

  const now = nowIso();
  // 두 문장은 같은 조건(확정 가능한 DRAFT 인가)을 각자 검사한다. 한 트랜잭션 안이므로
  // revision 증가와 확정은 함께 반영되거나 함께 반영되지 않는다.
  const submittable = `submit_status = 'DRAFT' AND nickname = ?3 AND goal_text = ?4
          AND length(goal_text) BETWEEN 1 AND 100
          AND EXISTS (SELECT 1 FROM roster WHERE id = participants.roster_id AND active = 1)`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE event SET revision = revision + 1, updated_at = ?2
        WHERE id = 1 AND status = 'OPEN' AND deadline_at > ?2
          AND EXISTS (SELECT 1 FROM participants WHERE id = ?1 AND ${submittable})`,
    ).bind(participantId, now, nickname.value.nickname, goal.value),
    env.DB.prepare(
      `UPDATE participants
          SET submit_status = 'SUBMITTED', submitted_at = ?2, updated_at = ?2
        WHERE id = ?1 AND ${submittable}
          AND EXISTS (SELECT 1 FROM event WHERE id = 1 AND status = 'OPEN' AND deadline_at > ?2)`,
    ).bind(participantId, now, nickname.value.nickname, goal.value),
  ]);

  if (results[1]!.meta.changes !== 1) {
    const own = await env.DB.prepare('SELECT submit_status, nickname, goal_text FROM participants WHERE id = ?1')
      .bind(participantId)
      .first<{ submit_status: SubmitStatus; nickname: string; goal_text: string }>();
    // 응답 유실 후 재전송: 이미 확정이면 성공으로 처리한다.
    if (own?.submit_status !== 'SUBMITTED') {
      const rejection = await editRejection(env, participantId, now);
      if (rejection.code === 'CONFLICT' && own && (own.nickname !== nickname.value.nickname || own.goal_text !== goal.value)) {
        throw new HttpError(409, 'CONTENT_CHANGED', '저장된 내용이 화면과 다릅니다. 새로 고침 후 다시 확인해 주세요.');
      }
      throw rejection;
    }
  }

  let eventStatus: SubmitResponse['eventStatus'] = 'OPEN';
  try {
    eventStatus = await tryAutoMatch(env.DB);
  } catch (error) {
    // 매칭 실패는 제출을 취소하지 않는다. 매분 Cron 이 다시 시도한다.
    console.error('auto_match_failed', error instanceof Error ? error.message : 'unknown');
  }
  const response: SubmitResponse = { submitted: true, eventStatus };
  return json(response);
}

/**
 * 배정 열람. 결과를 내려주기 전에 같은 트랜잭션에서 첫 열람을 기록한다.
 * 재매칭이 먼저 끝났다면 새 결과를, 열람이 먼저면 재매칭이 거부되므로 전달된 결과는 바뀌지 않는다.
 */
export async function viewAssignment(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, 'participant', { csrf: true });
  const now = nowIso();
  const [, viewResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE assignments SET viewed_at = COALESCE(viewed_at, ?2)
        WHERE santa_id = ?1
          AND match_run_id = (SELECT match_run_id FROM event WHERE id = 1 AND status IN ('MATCHED', 'CLOSED'))`,
    ).bind(session.participantId, now),
    env.DB.prepare(
      `SELECT rp.nickname AS receiverNickname, rp.goal_text AS assignedGoalText,
              rg.number AS receiverGiftNumber, mg.number AS myGiftNumber
         FROM assignments a
         JOIN event e ON e.id = 1 AND e.status IN ('MATCHED', 'CLOSED') AND e.match_run_id = a.match_run_id
         JOIN participants rp ON rp.id = a.receiver_id
         JOIN gift_numbers rg ON rg.participant_id = a.receiver_id AND rg.match_run_id = a.match_run_id
         JOIN gift_numbers mg ON mg.participant_id = a.santa_id AND mg.match_run_id = a.match_run_id
        WHERE a.santa_id = ?1 AND a.viewed_at IS NOT NULL`,
    ).bind(session.participantId),
  ]);
  const view = viewResult!.results[0] as unknown as AssignmentView | undefined;
  if (!view) {
    const event = await loadEvent(env.DB);
    if (event.status === 'DELETED') throw new HttpError(410, 'EVENT_DELETED', '행사 데이터가 삭제되었습니다.');
    throw new HttpError(409, 'NOT_MATCHED', '아직 매칭이 완료되지 않았습니다.');
  }
  return json(view);
}
