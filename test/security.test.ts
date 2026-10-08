import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  Client,
  count,
  eventRow,
  loginAdmin,
  matchedEvent,
  openEvent,
  register,
  rows,
  runCron,
  submit,
  view,
} from './helpers';

describe('인증과 요청 검증', () => {
  it('세션 없이는 개인·관리자 API 를 사용할 수 없다', async () => {
    await openEvent(['가람', '나래']);
    const anonymous = new Client();
    expect((await anonymous.get('/api/me')).status).toBe(401);
    expect((await anonymous.get('/api/admin/dashboard')).status).toBe(401);
    expect((await anonymous.get('/api/results')).status).toBe(401);
    expect((await anonymous.post('/api/me/submit', { nickname: '아무개', goalText: '목표' })).status).toBe(401);
    expect((await anonymous.post('/api/me/assignment/view')).status).toBe(401);
    expect((await anonymous.post('/api/admin/start', { expectedRevision: 0 })).status).toBe(401);
    expect((await anonymous.delete('/api/admin/data', { confirmName: '송년회' })).status).toBe(401);
  });

  it('참여자 세션으로 관리자 API 를, 관리자 세션으로 개인 API 를 쓸 수 없다', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람');
    expect((await a.client.get('/api/admin/dashboard')).status).toBe(401);
    expect((await a.client.post('/api/admin/close')).status).toBe(401);
    expect((await admin.get('/api/me')).status).toBe(401);

    // 참여자 쿠키 값을 관리자 쿠키 이름으로 보내도 통과하지 못한다
    const forged = new Client();
    forged.cookies.set('gx_admin', a.client.cookies.get('gx_part')!);
    expect((await forged.get('/api/admin/dashboard')).status).toBe(401);
  });

  it('쿠키 속성, no-store, DB 에는 해시만 저장', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람');

    const login = await new Client().post('/api/admin/login', { password: env.TEST_ADMIN_PASSWORD });
    expect(login.setCookies[0]).toMatch(/^gx_admin=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
    const access = await new Client().post('/api/access', { code: a.accessCode });
    expect(access.setCookies[0]).toMatch(/^gx_part=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);

    for (const result of [login, access, await a.client.get('/api/me'), await admin.get('/api/admin/dashboard'), await a.client.get('/api/event')]) {
      expect(result.headers.get('Cache-Control')).toBe('no-store');
    }

    const stored = JSON.stringify([await rows('SELECT * FROM participants'), await rows('SELECT * FROM sessions')]);
    expect(stored).not.toContain(a.accessCode);
    expect(stored).not.toContain(a.client.cookies.get('gx_part')!);
    expect(stored).not.toContain(admin.cookies.get('gx_admin')!);
    const [participant] = await rows('SELECT code_hash FROM participants');
    expect(participant!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Origin 이 다르거나 없으면, 또는 CSRF 토큰이 없으면 변경 요청을 거부한다', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람');

    expect((await a.client.request('PATCH', '/api/me/goal', { goalText: '공격' }, { origin: 'https://evil.example' })).body.error.code).toBe('BAD_ORIGIN');
    expect((await a.client.request('PATCH', '/api/me/goal', { goalText: '공격' }, { origin: null })).body.error.code).toBe('BAD_ORIGIN');
    expect((await a.client.request('PATCH', '/api/me/goal', { goalText: '공격' }, { csrf: null })).body.error.code).toBe('CSRF');
    expect((await a.client.request('PATCH', '/api/me/goal', { goalText: '공격' }, { csrf: 'wrong' })).body.error.code).toBe('CSRF');
    // 다른 세션의 CSRF 토큰도 통하지 않는다
    expect((await a.client.request('PATCH', '/api/me/goal', { goalText: '공격' }, { csrf: admin.csrf })).body.error.code).toBe('CSRF');
    expect((await admin.request('POST', '/api/admin/close', {}, { csrf: null })).body.error.code).toBe('CSRF');
    expect((await new Client().request('POST', '/api/admin/login', { password: env.TEST_ADMIN_PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await a.client.get('/api/me')).body.goalText).not.toBe('공격');

    // GET 은 상태를 바꾸지 않는다
    expect((await a.client.get('/api/me/submit')).status).toBe(405);
    expect((await admin.get('/api/admin/close')).status).toBe(405);
    expect((await admin.get('/api/unknown')).status).toBe(404);
  });

  it('잘못된 요청 본문을 거부한다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    expect((await a.client.patch('/api/me/goal', { goalText: 123 })).status).toBe(400);
    expect((await a.client.patch('/api/me/goal', { goalText: "'; DROP TABLE participants; --" })).status).toBe(200);
    expect(await count('participants')).toBe(1); // 바인딩되므로 SQL 로 실행되지 않는다
    expect((await new Client().post('/api/participants', { rosterId: '1 OR 1=1', nickname: '공격자', goalText: '' })).status).toBe(400);
  });

  it('관리자 로그인 실패가 누적되면 올바른 비밀번호도 일시 차단된다', async () => {
    const attacker = new Client();
    attacker.ip = '198.51.100.7';
    for (let i = 0; i < 5; i++) {
      expect((await attacker.post('/api/admin/login', { password: `wrong-${i}` })).status).toBe(401);
    }
    const blocked = await attacker.post('/api/admin/login', { password: env.TEST_ADMIN_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);

    // 다른 IP 는 영향을 받지 않고, IP 원문은 저장되지 않는다
    await loginAdmin();
    expect(JSON.stringify(await rows('SELECT * FROM auth_attempts'))).not.toContain('198.51.100.7');
  });

  it('접속 코드 실패가 누적되면 차단된다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    const attacker = new Client();
    attacker.ip = '198.51.100.8';
    for (let i = 0; i < 10; i++) {
      expect((await attacker.post('/api/access', { code: 'ABCDEFGHJKLMNPQR' })).status).toBe(401);
    }
    expect((await attacker.post('/api/access', { code: a.accessCode })).status).toBe(429);
    expect((await new Client().post('/api/access', { code: a.accessCode })).status).toBe(200);
  });

  it('로그아웃하면 세션이 폐기된다', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람');
    const cookie = a.client.cookies.get('gx_part')!;
    expect((await a.client.post('/api/logout', { role: 'participant' })).status).toBe(200);
    const replay = new Client();
    replay.cookies.set('gx_part', cookie);
    expect((await replay.get('/api/me')).status).toBe(401);
    expect((await admin.get('/api/admin/dashboard')).status).toBe(200); // 관리자 세션은 별개
    expect((await admin.post('/api/logout', { role: 'admin' })).status).toBe(200);
    expect((await admin.get('/api/admin/dashboard')).status).toBe(401);
  });

  it('만료된 세션은 거부된다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    await env.DB.prepare(`UPDATE sessions SET expires_at = ?1 WHERE role = 'participant'`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await a.client.get('/api/me')).status).toBe(401);
  });
});

describe('정보 노출 범위', () => {
  it('참여자는 다른 사람의 목표·배정·자신의 산타를 볼 수 없다', async () => {
    const { members } = await matchedEvent(5);
    const me = members[0]!;
    const mine = (await view(me)).body;
    const [santa] = await rows<{ nickname: string }>(
      `SELECT sp.nickname FROM assignments a JOIN participants sp ON sp.id = a.santa_id
         JOIN participants rp ON rp.id = a.receiver_id WHERE rp.nickname = ?1`,
      me.nickname,
    );
    const receiver = members.find((member) => member.nickname === mine.receiverNickname)!;

    const exposed = JSON.stringify([
      (await me.client.get('/api/me')).body,
      mine,
      (await me.client.get('/api/event')).body,
      (await me.client.get('/api/results')).body,
      (await me.client.get('/api/roster')).body,
    ]);
    expect(exposed).not.toContain(santa!.nickname); // 공개 전에는 나의 산타를 알 수 없다
    for (const member of members) {
      if (member !== me && member !== receiver) {
        expect(exposed).not.toContain(member.goal);
        expect(exposed).not.toContain(member.nickname);
      }
    }
    // 다른 참여자를 지정해 조회할 방법이 없다(본문·쿼리의 ID 는 무시된다)
    const spoof = await me.client.post('/api/me/assignment/view?participantId=2', { participantId: 2, santaId: 2 });
    expect(spoof.body).toEqual(mine);
  });

  it('관리자 현황에는 목표·코드·선물 번호·배정 상대가 없다', async () => {
    const { admin, members } = await matchedEvent(5);
    await view(members[0]!);
    const dashboard = await admin.dashboard();
    const serialized = JSON.stringify(dashboard);

    for (const member of members) {
      expect(serialized).toContain(member.nickname); // 운영용: 이름과 닉네임
      expect(serialized).toContain(member.name);
      expect(serialized).not.toContain(member.goal);
      expect(serialized).not.toContain(member.accessCode);
    }
    expect(serialized).not.toMatch(/goal|number|receiver|santa|code|match_run|runId/i);
    expect(Object.keys(dashboard.roster[0]!.participant!).sort()).toEqual(['id', 'nickname', 'submitStatus', 'submittedAt', 'viewed']);
    expect(dashboard.counts).toEqual({ active: 5, registered: 5, submitted: 5, viewed: 1 });
    expect(dashboard.event.matchedAt).not.toBeNull();

    // 공개 전에는 관리자도 전체 매칭을 볼 수 없다
    expect((await admin.get('/api/results')).status).toBe(403);
    await admin.post('/api/admin/close');
    expect((await admin.get('/api/results')).status).toBe(403);
  });
});

describe('접속 코드 재발급', () => {
  it('재발급 즉시 기존 코드와 세션이 무효화된다', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람');
    const b = await register('나래');
    const secondDevice = new Client();
    expect((await secondDevice.post('/api/access', { code: a.accessCode })).status).toBe(200);

    const id = await admin.participantId('가람');
    const reissued = await admin.post(`/api/admin/participants/${id}/reissue-code`);
    expect(reissued.status).toBe(200);
    const newCode = reissued.body.accessCode as string;
    expect(newCode).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    expect(newCode).not.toBe(a.accessCode);

    expect((await a.client.get('/api/me')).status).toBe(401);
    expect((await secondDevice.get('/api/me')).status).toBe(401);
    expect((await a.client.patch('/api/me/goal', { goalText: '옛 세션' })).status).toBe(401);
    expect((await new Client().post('/api/access', { code: a.accessCode })).status).toBe(401);
    expect(await rows('SELECT 1 FROM sessions s JOIN participants p ON p.id = s.participant_id WHERE p.id = ?1', id)).toHaveLength(0);

    const fresh = new Client();
    expect((await fresh.post('/api/access', { code: newCode })).status).toBe(200);
    expect((await fresh.get('/api/me')).body).toMatchObject({ nickname: a.nickname, goalText: a.goal }); // 내용은 유지
    expect((await b.client.get('/api/me')).status).toBe(200); // 다른 사람은 영향 없음

    // 새 코드는 DB 에 원문으로 남지 않고, 관리자 현황에서도 조회할 수 없다
    expect(JSON.stringify(await rows('SELECT * FROM participants'))).not.toContain(newCode);
    expect(JSON.stringify(await admin.dashboard())).not.toContain(newCode);
    expect((await admin.post('/api/admin/participants/99999/reissue-code')).status).toBe(404);
  });

  it('매칭 후에도 재발급할 수 있고 배정은 그대로다', async () => {
    const { admin, members } = await matchedEvent(3);
    const before = (await view(members[0]!)).body;
    const id = await admin.participantId(members[0]!.name);
    const newCode = (await admin.post(`/api/admin/participants/${id}/reissue-code`)).body.accessCode;
    expect((await view(members[0]!)).status).toBe(401);
    const fresh = new Client();
    await fresh.post('/api/access', { code: newCode });
    expect((await fresh.post('/api/me/assignment/view')).body).toEqual(before);
  });
});

describe('종료 후 데이터 삭제', () => {
  it('CLOSED 에서만, 행사명을 정확히 입력해야 삭제된다', async () => {
    const { admin } = await matchedEvent(3);
    expect((await admin.delete('/api/admin/data', { confirmName: '송년회' })).body.error.code).toBe('INVALID_STATE');
    await admin.post('/api/admin/close');
    expect((await admin.delete('/api/admin/data', { confirmName: '송년' })).body.error.code).toBe('CONFIRM_MISMATCH');
    expect((await admin.delete('/api/admin/data', {})).body.error.code).toBe('CONFIRM_MISMATCH');
    expect(await count('participants')).toBe(3);
    expect((await eventRow()).status).toBe('CLOSED');
  });

  it('삭제 후에는 개인정보가 남지 않고 조회·재등록·복구 매칭이 모두 차단된다', async () => {
    const { admin, members } = await matchedEvent(4);
    const me = members[0]!;
    await view(me);
    await admin.post('/api/admin/close');
    await admin.post('/api/admin/reveal');
    const rosterId = (await admin.dashboard()).roster[0]!.id;

    expect((await admin.delete('/api/admin/data', { confirmName: '송년회' })).status).toBe(200);
    expect((await admin.delete('/api/admin/data', { confirmName: '송년회' })).status).toBe(200); // 재전송

    for (const table of ['assignments', 'gift_numbers', 'participants', 'roster', 'auth_attempts', 'tx_guard']) {
      expect(await count(table)).toBe(0);
    }
    expect(await rows(`SELECT 1 FROM sessions WHERE role = 'participant'`)).toHaveLength(0);
    const event = await eventRow();
    expect(event).toMatchObject({ status: 'DELETED', name: '', budget_note: '', deadline_at: null, match_run_id: null, matched_at: null, closed_at: null, revealed_at: null });
    expect(event.deleted_at).not.toBeNull();
    const everything = JSON.stringify([event, await rows('SELECT * FROM sessions')]);
    for (const member of members) {
      expect(everything).not.toContain(member.nickname);
      expect(everything).not.toContain(member.goal);
    }

    // 조회 차단
    expect((await me.client.get('/api/me')).status).toBe(410);
    expect((await view(me)).status).toBe(410);
    expect((await me.client.get('/api/results')).status).toBe(410);
    expect((await admin.get('/api/results')).status).toBe(410);
    expect((await new Client().post('/api/access', { code: me.accessCode })).status).toBe(410);
    expect((await new Client().get('/api/event')).body).toMatchObject({ status: 'DELETED', name: '', revealed: false });

    // 재등록 차단
    expect((await new Client().get('/api/roster')).status).toBe(410);
    expect((await new Client().post('/api/participants', { rosterId, nickname: '다시등록', goalText: '' })).status).toBe(410);

    // 관리자 변경·복구 매칭 차단
    const dashboard = await admin.dashboard();
    expect(dashboard.event.status).toBe('DELETED');
    expect(dashboard.roster).toEqual([]);
    for (const path of ['/api/admin/rematch', '/api/admin/close', '/api/admin/reveal']) {
      expect((await admin.post(path)).status).toBe(409);
    }
    expect((await admin.op('POST', '/api/admin/roster', { names: ['새사람'] })).status).toBe(409);
    expect((await admin.op('POST', '/api/admin/start')).status).toBe(409);
    expect((await admin.op('POST', '/api/admin/match')).status).toBe(409);
    expect((await admin.patch('/api/admin/settings', { name: '새 행사', budgetNote: '', deadlineAt: new Date(Date.now() + 1e7).toISOString() })).status).toBe(409);
    await runCron();
    expect((await eventRow()).status).toBe('DELETED');
    expect(await count('assignments')).toBe(0);
  });

  it('삭제 후 관리자가 새 행사를 열 수 있고 이전 행사의 자격은 이어지지 않는다', async () => {
    const { admin, members } = await matchedEvent(3);
    const old = members[0]!;
    expect((await admin.post('/api/admin/new-event')).body.error.code).toBe('INVALID_STATE'); // 삭제 전에는 불가
    await admin.post('/api/admin/close');
    expect((await admin.post('/api/admin/new-event')).status).toBe(409);
    await admin.delete('/api/admin/data', { confirmName: '송년회' });
    expect((await new Client().post('/api/admin/new-event')).status).toBe(401);

    expect((await admin.post('/api/admin/new-event')).status).toBe(200);
    expect((await admin.post('/api/admin/new-event')).status).toBe(200); // 재전송
    const event = await eventRow();
    expect(event).toMatchObject({ status: 'SETUP', name: '', deadline_at: null, match_run_id: null, deleted_at: null, revealed_at: null });
    expect((await admin.dashboard()).roster).toEqual([]);

    // 이전 행사의 세션·코드는 새 행사에서 통하지 않는다
    expect((await old.client.get('/api/me')).status).toBe(401);
    expect((await new Client().post('/api/access', { code: old.accessCode })).status).toBe(401);

    // 새 행사를 처음부터 끝까지 진행할 수 있다
    expect((await admin.patch('/api/admin/settings', { name: '신년회', budgetNote: '', deadlineAt: new Date(Date.now() + 1e7).toISOString() })).status).toBe(200);
    expect((await admin.op('POST', '/api/admin/roster', { names: ['하나', '두리'] })).status).toBe(201);
    expect((await admin.op('POST', '/api/admin/start')).status).toBe(200);
    const a = await register('하나', old.nickname); // 이전 행사의 닉네임도 다시 쓸 수 있다
    const b = await register('두리');
    await submit(a);
    expect((await submit(b)).body.eventStatus).toBe('MATCHED');
    const assignment = (await view(a)).body;
    expect(assignment.receiverNickname).toBe(b.nickname);
    expect(JSON.stringify(assignment)).not.toContain(old.goal);
    expect(await count('assignments')).toBe(2);
  });

  it('비공개로 종료한 행사도 삭제할 수 있다', async () => {
    const { admin, members } = await matchedEvent(2);
    await admin.post('/api/admin/close');
    expect((await admin.delete('/api/admin/data', { confirmName: ' 송년회 ' })).status).toBe(200);
    expect((await submit(members[0]!)).status).toBe(410);
  });
});
