// 매칭 결과의 원자적 저장.
//
// D1 의 batch() 는 하나의 트랜잭션이지만, 조건부 UPDATE 가 0행을 바꾸는 것은 실패가 아니다.
// 그래서 첫 문장(행사 소유권 획득)이 조건에 걸려 아무것도 바꾸지 못했을 때 뒤 문장이 실행되지
// 않도록, 모든 후속 쓰기에 "event.match_run_id 가 이번 실행 ID 인가" 조건을 붙인다.

import type { EventStatus } from '../shared/types';
import { randomToken } from './crypto';
import { HttpError, nowIso } from './http';
import { buildMatchPlan, type MatchPlan } from './matching';

export interface MatchSnapshot {
  status: EventStatus;
  revision: number;
  matchRunId: string | null;
  deadlineAt: string | null;
  revealedAt: string | null;
  /** 활성 명단 한 줄. 등록 전이면 participantId 가 null. */
  roster: { rosterId: number; participantId: number | null; submitted: boolean }[];
}

interface EventSnapshotRow {
  status: EventStatus;
  revision: number;
  match_run_id: string | null;
  deadline_at: string | null;
  revealed_at: string | null;
}

/** 행사 상태와 활성 명단을 한 트랜잭션에서 읽어 일관된 snapshot 을 만든다. */
export async function readSnapshot(db: D1Database): Promise<MatchSnapshot> {
  const [eventResult, rosterResult] = await db.batch([
    db.prepare('SELECT status, revision, match_run_id, deadline_at, revealed_at FROM event WHERE id = 1'),
    db.prepare(
      `SELECT r.id AS roster_id, p.id AS participant_id, p.submit_status
         FROM roster r LEFT JOIN participants p ON p.roster_id = r.id
        WHERE r.active = 1
        ORDER BY r.id`,
    ),
  ]);
  const event = eventResult!.results[0] as unknown as EventSnapshotRow;
  const rows = rosterResult!.results as unknown as {
    roster_id: number;
    participant_id: number | null;
    submit_status: string | null;
  }[];
  return {
    status: event.status,
    revision: event.revision,
    matchRunId: event.match_run_id,
    deadlineAt: event.deadline_at,
    revealedAt: event.revealed_at,
    roster: rows.map((row) => ({
      rosterId: row.roster_id,
      participantId: row.participant_id,
      submitted: row.submit_status === 'SUBMITTED',
    })),
  };
}

const OWNS_RUN = `EXISTS (SELECT 1 FROM event WHERE id = 1 AND status = 'MATCHED' AND match_run_id = ?1)`;

/** 번호·배정 저장과 최종 불변식 검사. 모든 문장이 실행 ID 소유권을 조건으로 한다. */
function resultStatements(db: D1Database, runId: string, plan: MatchPlan): D1PreparedStatement[] {
  const count = plan.pairs.length;
  return [
    db
      .prepare(
        `INSERT INTO gift_numbers (participant_id, number, match_run_id)
         SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.n'), ?1
           FROM json_each(?2) AS j
          WHERE ${OWNS_RUN}`,
      )
      .bind(runId, JSON.stringify(plan.numbers)),
    db
      .prepare(
        `INSERT INTO assignments (santa_id, receiver_id, match_run_id)
         SELECT json_extract(j.value, '$.s'), json_extract(j.value, '$.r'), ?1
           FROM json_each(?2) AS j
          WHERE ${OWNS_RUN}`,
      )
      .bind(runId, JSON.stringify(plan.pairs)),
    // 소유권을 얻었는데 저장된 행 수가 다르면 CHECK 오류로 batch 전체를 롤백한다.
    db
      .prepare(
        `INSERT INTO tx_guard (ok)
         SELECT 0
          WHERE ${OWNS_RUN}
            AND ((SELECT COUNT(*) FROM assignments WHERE match_run_id = ?1) <> ?2
              OR (SELECT COUNT(*) FROM gift_numbers WHERE match_run_id = ?1) <> ?2
              OR (SELECT COUNT(*) FROM assignments) <> ?2
              OR (SELECT COUNT(*) FROM gift_numbers) <> ?2)`,
      )
      .bind(runId, count),
  ];
}

function claimed(results: D1Result[]): boolean {
  return results[0]!.meta.changes === 1;
}

/**
 * 전원 확정 상태의 snapshot 으로 계산한 결과를 저장한다.
 * snapshot 이후 명단·확정 상태가 바뀌었으면(revision 불일치) 아무것도 쓰지 않고 false.
 */
export async function commitAutoMatch(
  db: D1Database,
  snapshot: MatchSnapshot,
  plan: MatchPlan,
  runId: string,
  now: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE event
            SET status = 'MATCHED', match_run_id = ?1, matched_at = ?2, updated_at = ?2, revision = revision + 1
          WHERE id = 1 AND status = 'OPEN' AND revision = ?3
            AND (SELECT COUNT(*) FROM roster WHERE active = 1) = ?4
            AND NOT EXISTS (
                  SELECT 1 FROM roster r LEFT JOIN participants p ON p.roster_id = r.id
                   WHERE r.active = 1 AND (p.id IS NULL OR p.submit_status <> 'SUBMITTED'))`,
      )
      .bind(runId, now, snapshot.revision, plan.pairs.length),
    ...resultStatements(db, runId, plan),
  ]);
  return claimed(results);
}

/** 마감 후 관리자 수동 매칭: 미확정자 제외와 매칭 저장을 한 트랜잭션으로 처리한다. */
export async function commitForceMatch(
  db: D1Database,
  snapshot: MatchSnapshot,
  plan: MatchPlan,
  runId: string,
  now: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE event
            SET status = 'MATCHED', match_run_id = ?1, matched_at = ?2, updated_at = ?2, revision = revision + 1
          WHERE id = 1 AND status = 'OPEN' AND revision = ?3
            AND deadline_at IS NOT NULL AND deadline_at <= ?2
            AND (SELECT COUNT(*) FROM participants p JOIN roster r ON r.id = p.roster_id
                  WHERE r.active = 1 AND p.submit_status = 'SUBMITTED') = ?4`,
      )
      .bind(runId, now, snapshot.revision, plan.pairs.length),
    db
      .prepare(
        `DELETE FROM sessions
          WHERE participant_id IN (SELECT id FROM participants WHERE submit_status = 'DRAFT') AND ${OWNS_RUN}`,
      )
      .bind(runId),
    db.prepare(`DELETE FROM participants WHERE submit_status = 'DRAFT' AND ${OWNS_RUN}`).bind(runId),
    db
      .prepare(
        `UPDATE roster SET active = 0
          WHERE active = 1 AND id NOT IN (SELECT roster_id FROM participants) AND ${OWNS_RUN}`,
      )
      .bind(runId),
    ...resultStatements(db, runId, plan),
  ]);
  return claimed(results);
}

/** 재매칭: 아무도 열람하지 않았고 공개 전일 때만 이전 결과를 통째로 교체한다. */
export async function commitRematch(
  db: D1Database,
  previousRunId: string,
  plan: MatchPlan,
  runId: string,
  now: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE event
            SET match_run_id = ?1, matched_at = ?2, updated_at = ?2, revision = revision + 1
          WHERE id = 1 AND status = 'MATCHED' AND match_run_id = ?3 AND revealed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM assignments WHERE viewed_at IS NOT NULL)`,
      )
      .bind(runId, now, previousRunId),
    db.prepare(`DELETE FROM assignments WHERE match_run_id <> ?1 AND ${OWNS_RUN}`).bind(runId),
    db.prepare(`DELETE FROM gift_numbers WHERE match_run_id <> ?1 AND ${OWNS_RUN}`).bind(runId),
    ...resultStatements(db, runId, plan),
  ]);
  return claimed(results);
}

const AUTO_MATCH_ATTEMPTS = 3;

/**
 * OPEN 이고 활성 명단 전원이 확정했으면 매칭한다. 제출 직후, 명단 제외 직후, 매분 Cron 에서 호출한다.
 * 경쟁에서 지면 최신 snapshot 으로 제한적으로 재시도한다. 결과 내용은 반환하지 않는다.
 */
export async function tryAutoMatch(db: D1Database): Promise<EventStatus> {
  let status: EventStatus = 'OPEN';
  for (let attempt = 0; attempt < AUTO_MATCH_ATTEMPTS; attempt++) {
    const snapshot = await readSnapshot(db);
    status = snapshot.status;
    if (snapshot.status !== 'OPEN') return status;
    if (snapshot.roster.length < 2 || snapshot.roster.some((row) => !row.submitted)) return status;
    const plan = buildMatchPlan(snapshot.roster.map((row) => row.participantId!));
    if (await commitAutoMatch(db, snapshot, plan, randomToken(), nowIso())) return 'MATCHED';
  }
  return status;
}

export async function forceMatch(db: D1Database, expectedRevision: number): Promise<void> {
  const snapshot = await readSnapshot(db);
  if (snapshot.status === 'MATCHED') return; // 같은 요청의 재전송
  if (snapshot.status !== 'OPEN') throw new HttpError(409, 'INVALID_STATE', '지금은 매칭할 수 없는 상태입니다.');
  const now = nowIso();
  if (!snapshot.deadlineAt || snapshot.deadlineAt > now) {
    throw new HttpError(409, 'BEFORE_DEADLINE', '수동 매칭은 마감 이후에만 할 수 있습니다.');
  }
  if (snapshot.revision !== expectedRevision) {
    throw new HttpError(409, 'STALE', '현황이 바뀌었습니다. 새로 고친 내용을 확인한 뒤 다시 시도해 주세요.');
  }
  const submitted = snapshot.roster.filter((row) => row.submitted).map((row) => row.participantId!);
  if (submitted.length < 2) {
    throw new HttpError(409, 'NOT_ENOUGH', '확정 제출자가 2명 이상이어야 매칭할 수 있습니다.');
  }
  const plan = buildMatchPlan(submitted);
  if (!(await commitForceMatch(db, snapshot, plan, randomToken(), now))) {
    throw new HttpError(409, 'STALE', '현황이 바뀌었습니다. 새로 고친 내용을 확인한 뒤 다시 시도해 주세요.');
  }
}

export async function rematch(db: D1Database): Promise<void> {
  const [eventResult, assignmentResult] = await db.batch([
    db.prepare('SELECT status, match_run_id, revealed_at FROM event WHERE id = 1'),
    db.prepare(
      `SELECT a.santa_id, a.viewed_at FROM assignments a
         JOIN event e ON e.id = 1 AND e.match_run_id = a.match_run_id
        ORDER BY a.santa_id`,
    ),
  ]);
  const event = eventResult!.results[0] as unknown as Pick<EventSnapshotRow, 'status' | 'match_run_id' | 'revealed_at'>;
  const rows = assignmentResult!.results as unknown as { santa_id: number; viewed_at: string | null }[];
  if (event.status !== 'MATCHED' || !event.match_run_id) {
    throw new HttpError(409, 'INVALID_STATE', '재매칭은 매칭 완료 후 행사 종료 전에만 할 수 있습니다.');
  }
  if (event.revealed_at || rows.some((row) => row.viewed_at)) {
    throw new HttpError(409, 'ALREADY_VIEWED', '이미 배정을 확인한 참여자가 있어 재매칭할 수 없습니다.');
  }
  const plan = buildMatchPlan(rows.map((row) => row.santa_id));
  if (!(await commitRematch(db, event.match_run_id, plan, randomToken(), nowIso()))) {
    throw new HttpError(409, 'ALREADY_VIEWED', '그 사이 배정을 확인한 참여자가 있거나 상태가 바뀌어 재매칭하지 못했습니다.');
  }
}
