// 경합 검증. 실제 Worker 핸들러와 로컬 D1 을 사용한다.
// - Promise.all 로 요청을 겹쳐 보내는 테스트는 어떤 순서로 처리되든 불변식이 지켜지는지 본다.
// - "결정적" 테스트는 매칭 단계(snapshot 읽기 → 저장) 사이에 다른 요청을 끼워 넣어 특정 순서를 강제한다.

import { describe, expect, it } from 'vitest';
import { randomToken } from '../src/worker/crypto';
import { commitAutoMatch, commitRematch, readSnapshot } from '../src/worker/matchService';
import { buildMatchPlan } from '../src/worker/matching';
import {
  Client,
  count,
  db,
  eventRow,
  expectValidStoredMatch,
  injectAssignmentFailure,
  inviteFor,
  matchedEvent,
  names,
  openEvent,
  register,
  registerAll,
  removeAssignmentFailure,
  resetDb,
  rows,
  runCron,
  submit,
  view,
  type Member,
} from './helpers';

const now = () => new Date().toISOString();

/** 전원 확정이지만 매칭은 아직 안 된 OPEN 상태(매칭 저장 실패 직후와 같은 상태)를 만든다. */
async function allSubmittedButUnmatched(size: number) {
  const rosterNames = names(size);
  const admin = await openEvent(rosterNames);
  const members = await registerAll(rosterNames);
  await injectAssignmentFailure();
  for (const member of members) expect((await submit(member)).status).toBe(200);
  await removeAssignmentFailure();
  expect((await eventRow()).status).toBe('OPEN');
  return { admin, members };
}

async function expectNothingStored() {
  const event = await eventRow();
  expect(event.status).toBe('OPEN');
  expect(event.match_run_id).toBeNull();
  expect(await count('assignments')).toBe(0);
  expect(await count('gift_numbers')).toBe(0);
}

describe('동시 제출', () => {
  it('마지막 두 명이 동시에 제출해도 결과는 한 번만 저장된다', async () => {
    for (let round = 0; round < 8; round++) {
      await resetDb();
      const rosterNames = names(6);
      await openEvent(rosterNames);
      const members = await registerAll(rosterNames);
      for (const member of members.slice(0, 4)) await submit(member);

      const [first, second] = await Promise.all([submit(members[4]!), submit(members[5]!)]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await eventRow()).status).toBe('MATCHED');
      await expectValidStoredMatch(6);
    }
  });

  it('전원이 동시에 제출해도 한 번만 매칭된다', async () => {
    const rosterNames = names(12);
    await openEvent(rosterNames);
    const members = await registerAll(rosterNames);
    const results = await Promise.all(members.map(submit));
    for (const result of results) expect(result.status).toBe(200);
    // 경쟁에 진 요청이 재시도 한도 안에 끝내지 못했더라도 복구 작업이 마무리한다.
    await runCron();
    await expectValidStoredMatch(12);

    // 새로 고침(재조회)해도 같은 결과
    const firstView = (await view(members[0]!)).body;
    await runCron();
    expect((await view(members[0]!)).body).toEqual(firstView);
  });

  it('같은 참여자의 중복 제출 요청은 한 번만 반영된다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    const before = (await eventRow()).revision;
    const results = await Promise.all([submit(a), submit(a), submit(a)]);
    for (const result of results) expect(result.status).toBe(200);
    expect((await eventRow()).revision).toBe(before + 1);
  });
});

describe('동시 등록·닉네임', () => {
  it('같은 이름을 동시에 등록하면 한 명만 성공한다', async () => {
    await openEvent(['가람', '나래']);
    const option = (await new Client().get('/api/roster')).body.roster.find((item: any) => item.name === '가람');
    const inviteCode = await inviteFor('가람');
    const clients = [new Client(), new Client(), new Client()];
    const results = await Promise.all(
      clients.map((client, i) => client.post('/api/participants', { rosterId: option.id, nickname: `후보${i}번`, goalText: '', inviteCode })),
    );
    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
    for (const result of results) if (result.status === 409) expect(result.body.error.code).toBe('NAME_TAKEN');
    expect(await count('participants')).toBe(1);
    // 실패한 요청의 세션은 만들어지지 않는다(관리자 1 + 성공한 참여자 1)
    expect(await count('sessions')).toBe(2);
    const losers = clients.filter((_, i) => results[i]!.status === 409);
    for (const loser of losers) expect((await loser.get('/api/me')).status).toBe(401);
  });

  it('같은 닉네임(정규화 기준)을 동시에 등록하면 한 명만 성공한다', async () => {
    await openEvent(['가람', '나래', '다온']);
    const roster = (await new Client().get('/api/roster')).body.roster;
    const nicknames = ['Rudolph', 'ｒｕｄｏｌｐｈ', 'RUDOLPH'];
    const invites: string[] = [];
    for (const option of roster) invites.push(await inviteFor(option.name));
    const results = await Promise.all(
      roster.map((option: any, i: number) =>
        new Client().post('/api/participants', { rosterId: option.id, nickname: nicknames[i], goalText: '', inviteCode: invites[i] }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
    for (const result of results) if (result.status === 409) expect(result.body.error.code).toBe('NICKNAME_TAKEN');
    expect(await count('participants')).toBe(1);
  });

  it('두 사람이 동시에 같은 닉네임으로 수정하면 한 명만 성공한다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    const b = await register('나래');
    const results = await Promise.all([
      a.client.patch('/api/me/nickname', { nickname: '산타 Claus' }),
      b.client.patch('/api/me/nickname', { nickname: '산타  claus' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await rows(`SELECT 1 FROM participants WHERE normalized_nickname = '산타 claus'`)).toHaveLength(1);
  });
});

describe('제출과 명단 변경의 경합', () => {
  it('[결정적] snapshot 이후 명단이 추가되면 stale 결과를 저장하지 않는다', async () => {
    const { admin } = await allSubmittedButUnmatched(4);
    const snapshot = await readSnapshot(db());
    const plan = buildMatchPlan(snapshot.roster.map((row) => row.participantId!));

    expect((await admin.op('POST', '/api/admin/roster', { names: ['늦게 추가'] })).status).toBe(201);

    expect(await commitAutoMatch(db(), snapshot, plan, randomToken(), now())).toBe(false);
    await expectNothingStored();
    await runCron(); // 미등록자가 생겼으므로 복구 작업도 매칭하지 않는다
    await expectNothingStored();
  });

  it('[결정적] snapshot 이후 확정이 해제되면 저장하지 않는다', async () => {
    const { admin, members } = await allSubmittedButUnmatched(4);
    const snapshot = await readSnapshot(db());
    const plan = buildMatchPlan(snapshot.roster.map((row) => row.participantId!));

    const id = await admin.participantId(members[0]!.name);
    expect((await admin.op('POST', `/api/admin/participants/${id}/unsubmit`)).status).toBe(200);

    expect(await commitAutoMatch(db(), snapshot, plan, randomToken(), now())).toBe(false);
    await expectNothingStored();
  });

  it('[결정적] 해제 후 다시 확정해 조건이 같아 보여도 revision 이 다르면 저장하지 않는다', async () => {
    const { admin, members } = await allSubmittedButUnmatched(3);
    const snapshot = await readSnapshot(db());
    const plan = buildMatchPlan(snapshot.roster.map((row) => row.participantId!));

    // 초기화 → 같은 이름으로 재등록 → 전원 확정(이번에는 매칭 저장이 다시 실패하도록 해 OPEN 유지)
    const id = await admin.participantId(members[0]!.name);
    expect((await admin.op('POST', `/api/admin/participants/${id}/reset`)).status).toBe(200);
    await injectAssignmentFailure();
    const again = await register(members[0]!.name, '돌아온사람');
    expect((await submit(again)).status).toBe(200);
    await removeAssignmentFailure();

    expect(await commitAutoMatch(db(), snapshot, plan, randomToken(), now())).toBe(false);
    await expectNothingStored();

    await runCron(); // 최신 snapshot 으로는 정상 매칭
    await expectValidStoredMatch(3);
  });

  it('[결정적] 같은 snapshot 으로 두 번 저장해도 첫 번째만 반영된다', async () => {
    await allSubmittedButUnmatched(5);
    const snapshot = await readSnapshot(db());
    const ids = snapshot.roster.map((row) => row.participantId!);
    const [first, second] = await Promise.all([
      commitAutoMatch(db(), snapshot, buildMatchPlan(ids), randomToken(), now()),
      commitAutoMatch(db(), snapshot, buildMatchPlan(ids), randomToken(), now()),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    await expectValidStoredMatch(5);
  });

  it('마지막 제출과 명단 추가·제외·확정 해제를 겹쳐 보내도 stale 명단으로 매칭되지 않는다', async () => {
    const changes: ((admin: Awaited<ReturnType<typeof openEvent>>, members: Member[]) => Promise<{ method: any; path: string; body?: any }>)[] = [
      async () => ({ method: 'POST', path: '/api/admin/roster', body: { names: ['끼어든 사람'] } }),
      async (admin) => ({ method: 'DELETE', path: `/api/admin/roster/${await admin.rosterId('미등록')}` }),
      async (admin, members) => ({ method: 'POST', path: `/api/admin/participants/${await admin.participantId(members[0]!.name)}/unsubmit` }),
    ];
    for (const makeChange of changes) {
      for (let round = 0; round < 4; round++) {
        await resetDb();
        const rosterNames = names(4);
        const admin = await openEvent([...rosterNames, '미등록']);
        const members = await registerAll(rosterNames);
        for (const member of members.slice(0, 3)) await submit(member);

        const change = await makeChange(admin, members);
        const revision = (await admin.dashboard()).event.revision;
        const [submitResult, changeResult] = await Promise.all([
          submit(members[3]!),
          admin.request(change.method, change.path, { ...change.body, expectedRevision: revision }),
        ]);
        expect(submitResult.status).toBe(200);
        expect([200, 201, 409]).toContain(changeResult.status);
        await runCron();

        // 불변식: 매칭됐다면 저장된 배정은 현재 활성 명단 전원(모두 확정)과 정확히 일치한다.
        const event = await eventRow();
        const active = await rows<{ submit_status: string | null }>(
          'SELECT p.submit_status FROM roster r LEFT JOIN participants p ON p.roster_id = r.id WHERE r.active = 1',
        );
        const allSubmitted = active.every((row) => row.submit_status === 'SUBMITTED');
        if (event.status === 'MATCHED') {
          expect(allSubmitted).toBe(true);
          await expectValidStoredMatch(active.length);
        } else {
          expect(event.status).toBe('OPEN');
          expect(allSubmitted).toBe(false);
          expect(await count('assignments')).toBe(0);
          expect(await count('gift_numbers')).toBe(0);
        }
      }
    }
  });
});

describe('매칭 저장 실패와 복구', () => {
  it('batch 중간 오류 시 상태·번호·배정이 모두 롤백되고 확정 제출은 유지된다', async () => {
    const rosterNames = names(5);
    await openEvent(rosterNames);
    const members = await registerAll(rosterNames);
    for (const member of members.slice(0, 4)) await submit(member);

    // 번호 INSERT 는 성공하고 그 뒤 배정 INSERT 에서 실패한다.
    await injectAssignmentFailure();
    const last = await submit(members[4]!);
    expect(last.status).toBe(200);
    expect(last.body).toEqual({ submitted: true, eventStatus: 'OPEN' }); // 제출 완료, 매칭 처리 중

    await expectNothingStored();
    expect((await eventRow()).matched_at).toBeNull();
    expect(await rows(`SELECT 1 FROM participants WHERE submit_status = 'SUBMITTED'`)).toHaveLength(5);
    expect((await members[4]!.client.get('/api/me')).body).toMatchObject({ submitStatus: 'SUBMITTED', event: { status: 'OPEN' } });

    // 장애가 계속되는 동안 복구 작업이 실패해도 상태는 그대로다
    await runCron();
    await expectNothingStored();

    // 장애 해소 후 복구 작업이 정상 완료한다(마감이 지났어도 실행)
    await removeAssignmentFailure();
    await db().prepare('UPDATE event SET deadline_at = ?1 WHERE id = 1').bind(new Date(Date.now() - 1000).toISOString()).run();
    await runCron();
    await expectValidStoredMatch(5);
    const runId = (await eventRow()).match_run_id;
    await runCron(); // 이미 매칭된 뒤에는 아무것도 바꾸지 않는다
    expect((await eventRow()).match_run_id).toBe(runId);
  });

  it('전원 확정이 아니면 복구 작업은 매칭하지 않는다', async () => {
    await openEvent(['가람', '나래', '다온']);
    await submit(await register('가람'));
    await submit(await register('나래'));
    await runCron();
    await expectNothingStored();
  });
});

describe('첫 열람과 재매칭의 경합', () => {
  it('아무도 열람하지 않았으면 재매칭이 결과를 통째로 교체한다', async () => {
    const { admin, members } = await matchedEvent(6);
    const before = (await eventRow()).match_run_id;
    expect((await admin.post('/api/admin/rematch')).status).toBe(200);
    const event = await eventRow();
    expect(event.status).toBe('MATCHED'); // 도중에 OPEN 으로 노출되지 않는다
    expect(event.match_run_id).not.toBe(before);
    await expectValidStoredMatch(6);
    expect(await rows('SELECT 1 FROM assignments WHERE match_run_id = ?1', before)).toHaveLength(0);
    expect(await rows('SELECT 1 FROM gift_numbers WHERE match_run_id = ?1', before)).toHaveLength(0);
    expect((await view(members[0]!)).status).toBe(200);
  });

  it('한 명이라도 열람했으면 재매칭을 거부한다', async () => {
    const { admin, members } = await matchedEvent(4);
    const seen = (await view(members[2]!)).body;
    const result = await admin.post('/api/admin/rematch');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('ALREADY_VIEWED');
    expect((await view(members[2]!)).body).toEqual(seen);
  });

  it('[결정적] 재매칭 계산과 저장 사이에 열람이 일어나면 이미 전달된 결과는 바뀌지 않는다', async () => {
    const { members } = await matchedEvent(6);
    const previousRunId = (await eventRow()).match_run_id as string;
    const storedBefore = await rows('SELECT * FROM assignments ORDER BY santa_id');
    const numbersBefore = await rows('SELECT * FROM gift_numbers ORDER BY participant_id');
    const plan = buildMatchPlan(storedBefore.map((row) => row.santa_id as number)); // 재매칭 계산 완료

    const delivered = (await view(members[0]!)).body; // 그 사이 첫 열람

    expect(await commitRematch(db(), previousRunId, plan, randomToken(), now())).toBe(false);
    expect((await eventRow()).match_run_id).toBe(previousRunId);
    const storedAfter = await rows('SELECT * FROM assignments ORDER BY santa_id');
    expect(storedAfter.map(({ viewed_at, ...rest }) => rest)).toEqual(storedBefore.map(({ viewed_at, ...rest }) => rest));
    expect(await rows('SELECT * FROM gift_numbers ORDER BY participant_id')).toEqual(numbersBefore);
    expect((await view(members[0]!)).body).toEqual(delivered);
  });

  it('[결정적] 재매칭이 먼저 끝나면 열람은 이전 버전이 아닌 새 결과만 반환한다', async () => {
    const { members } = await matchedEvent(6);
    const previousRunId = (await eventRow()).match_run_id as string;
    const ids = (await rows<{ santa_id: number }>('SELECT santa_id FROM assignments ORDER BY santa_id')).map((row) => row.santa_id);
    const runId = randomToken();
    expect(await commitRematch(db(), previousRunId, buildMatchPlan(ids), runId, now())).toBe(true);

    const me = members[0]!;
    const delivered = (await view(me)).body;
    const [stored] = await rows(
      `SELECT rp.nickname, rg.number AS receiver_number, mg.number AS my_number, a.match_run_id
         FROM assignments a JOIN participants sp ON sp.id = a.santa_id JOIN participants rp ON rp.id = a.receiver_id
         JOIN gift_numbers rg ON rg.participant_id = a.receiver_id JOIN gift_numbers mg ON mg.participant_id = a.santa_id
        WHERE sp.nickname = ?1`,
      me.nickname,
    );
    expect(stored!.match_run_id).toBe(runId);
    expect(delivered).toMatchObject({ receiverNickname: stored!.nickname, receiverGiftNumber: stored!.receiver_number, myGiftNumber: stored!.my_number });

    // 같은 이전 run ID 로 다시 저장하려는 늦은 요청은 아무것도 바꾸지 않는다
    expect(await commitRematch(db(), previousRunId, buildMatchPlan(ids), randomToken(), now())).toBe(false);
    expect((await view(me)).body).toEqual(delivered);
    await expectValidStoredMatch(6);
  });

  it('열람과 재매칭을 겹쳐 보내도 전달된 결과는 최종 저장 결과와 같다', async () => {
    for (let round = 0; round < 10; round++) {
      await resetDb();
      const { admin, members } = await matchedEvent(5);
      const viewers = members.slice(0, 3);
      const [rematchResult, ...views] = await Promise.all([admin.post('/api/admin/rematch'), ...viewers.map(view)]);
      expect([200, 409]).toContain(rematchResult.status);
      for (const result of views) expect(result.status).toBe(200);

      await expectValidStoredMatch(5);
      // 응답으로 전달된 내용이 지금 다시 조회한 내용과 같아야 한다(뒤에서 교체되지 않음).
      for (let i = 0; i < viewers.length; i++) {
        expect((await view(viewers[i]!)).body).toEqual(views[i]!.body);
      }
      // 열람이 기록된 뒤에는 재매칭이 더 이상 불가능하다.
      expect((await admin.post('/api/admin/rematch')).status).toBe(409);
    }
  });
});
