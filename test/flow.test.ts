import { describe, expect, it } from 'vitest';
import {
  Client,
  count,
  eventRow,
  expectValidStoredMatch,
  futureIso,
  goalFor,
  inviteFor,
  loginAdmin,
  matchedEvent,
  names,
  nicknameFor,
  openEvent,
  register,
  registerAll,
  rows,
  setDeadlinePassed,
  submit,
  view,
} from './helpers';

describe('관리자 설정과 참여 시작', () => {
  it('설정 → 명단 → 참여 시작, 인원은 활성 명단 수로 계산된다', async () => {
    const admin = await loginAdmin();
    expect((await new Client().get('/api/event')).body.status).toBe('SETUP');
    expect((await new Client().get('/api/roster')).status).toBe(409); // 참여 전에는 명단 비공개

    // 설정 전에는 시작할 수 없다
    expect((await admin.op('POST', '/api/admin/start')).body.error.code).toBe('NOT_READY');

    expect((await admin.patch('/api/admin/settings', { name: ' 2027  송년회 ', budgetNote: '2만원', deadlineAt: futureIso() })).status).toBe(200);
    expect((await admin.op('POST', '/api/admin/roster', { names: ['가람', '나래', '다온'] })).status).toBe(201);
    expect((await admin.op('POST', '/api/admin/roster', { names: ['라온'] })).status).toBe(201);

    // 정규화 후 같은 이름은 거부(공백·전각·대소문자)
    const duplicate = await admin.op('POST', '/api/admin/roster', { names: ['가 람'] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_NAME');
    expect((await admin.op('POST', '/api/admin/roster', { names: ['Min', 'ｍｉｎ'] })).status).toBe(400);

    // 변경·제외·복원
    const raonId = await admin.rosterId('라온');
    expect((await admin.op('PATCH', `/api/admin/roster/${raonId}`, { displayName: '라온 B' })).status).toBe(200);
    expect((await admin.op('PATCH', `/api/admin/roster/${raonId}`, { displayName: '가람' })).status).toBe(409);
    expect((await admin.op('DELETE', `/api/admin/roster/${raonId}`)).status).toBe(200);
    let dashboard = await admin.dashboard();
    expect(dashboard.counts.active).toBe(3);
    expect(dashboard.event.name).toBe('2027 송년회');
    expect((await admin.op('PATCH', `/api/admin/roster/${raonId}`, { active: true })).status).toBe(200);
    expect((await admin.dashboard()).counts.active).toBe(4);

    // 완전 삭제는 제외된 이름만 가능하고, 삭제한 이름은 다시 추가할 수 있다
    await admin.op('POST', '/api/admin/roster', { names: ['오타'] });
    const typoId = await admin.rosterId('오타');
    expect((await admin.op('DELETE', `/api/admin/roster/${typoId}`, { permanent: true })).status).toBe(409);
    expect((await admin.op('DELETE', `/api/admin/roster/${typoId}`)).status).toBe(200);
    expect((await admin.op('DELETE', `/api/admin/roster/${typoId}`, { permanent: true })).status).toBe(200);
    expect((await admin.dashboard()).roster.map((row) => row.name)).not.toContain('오타');
    expect((await admin.op('POST', '/api/admin/roster', { names: ['오타'] })).status).toBe(201);
    expect((await admin.op('DELETE', `/api/admin/roster/${await admin.rosterId('오타')}`)).status).toBe(200);
    expect((await admin.dashboard()).counts.active).toBe(4);

    // 오래된 현황으로 보낸 요청은 409
    dashboard = await admin.dashboard();
    expect((await admin.post('/api/admin/roster', { names: ['마루'], expectedRevision: dashboard.event.revision - 1 })).body.error.code).toBe('STALE');

    expect((await admin.op('POST', '/api/admin/start')).status).toBe(200);
    expect((await admin.op('POST', '/api/admin/start')).status).toBe(200); // 재전송
    expect((await eventRow()).status).toBe('OPEN');

    const roster = (await new Client().get('/api/roster')).body.roster;
    expect(roster).toHaveLength(4);
    expect(Object.keys(roster[0]).sort()).toEqual(['available', 'id', 'name']);
  });

  it('명단은 2~99명이어야 시작할 수 있고 99명을 넘길 수 없다', async () => {
    const admin = await loginAdmin();
    await admin.patch('/api/admin/settings', { name: '행사', budgetNote: '', deadlineAt: futureIso() });
    await admin.op('POST', '/api/admin/roster', { names: ['혼자'] });
    expect((await admin.op('POST', '/api/admin/start')).body.error.code).toBe('NOT_READY');
    expect((await admin.op('POST', '/api/admin/roster', { names: names(98) })).status).toBe(201);
    expect((await admin.op('POST', '/api/admin/roster', { names: ['백번째'] })).body.error.code).toBe('ROSTER_FULL');
    expect((await admin.dashboard()).counts.active).toBe(99);
  });

  it('과거 마감은 저장할 수 없다', async () => {
    const admin = await loginAdmin();
    const result = await admin.patch('/api/admin/settings', { name: '행사', budgetNote: '', deadlineAt: new Date(Date.now() - 1000).toISOString() });
    expect(result.status).toBe(400);
  });
});

describe('참여 등록·닉네임·목표', () => {
  it('닉네임은 직접 입력해야 하며 명단 이름으로 자동 설정되지 않는다', async () => {
    await openEvent(['가람', '나래']);
    const client = new Client();
    const option = (await client.get('/api/roster')).body.roster[0];
    expect((await client.post('/api/participants', { rosterId: option.id, goalText: '목표' })).status).toBe(400);
    expect((await client.post('/api/participants', { rosterId: option.id, nickname: '가', goalText: '' })).status).toBe(400);
    expect((await client.post('/api/participants', { rosterId: option.id, nickname: '가'.repeat(21), goalText: '' })).status).toBe(400);
    expect((await client.post('/api/participants', { rosterId: option.id, nickname: '루돌프', goalText: '가'.repeat(101) })).status).toBe(400);
    expect(await count('participants')).toBe(0);

    const inviteCode = await inviteFor(option.name);
    const ok = await client.post('/api/participants', { rosterId: option.id, nickname: '🎁'.repeat(20), goalText: '', inviteCode });
    expect(ok.status).toBe(201);
    expect(ok.body.accessCode).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    const me = (await client.get('/api/me')).body;
    expect(me.nickname).toBe('🎁'.repeat(20));
    expect(me.nickname).not.toBe(me.rosterName);

    // 등록된 이름은 선택할 수 없게 표시된다
    const roster = (await new Client().get('/api/roster')).body.roster;
    expect(roster.find((item: any) => item.id === option.id).available).toBe(false);
    // 이름 ↔ 닉네임 대응은 공개 명단에 없다
    expect(JSON.stringify(roster)).not.toContain('🎁');
  });

  it('임시저장, 닉네임 중복 차단, 접속 코드 재접속', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람', 'Santa', '');
    const b = await register('나래', '루돌프', '초안');

    expect((await b.client.patch('/api/me/nickname', { nickname: 'ｓａｎｔａ' })).body.error.code).toBe('NICKNAME_TAKEN');
    expect((await b.client.patch('/api/me/nickname', { nickname: '빨간코' })).status).toBe(200);
    expect((await b.client.patch('/api/me/goal', { goalText: '책 12권 읽기' })).status).toBe(200);
    // 자신의 닉네임을 같은 값으로 저장하는 것은 허용
    expect((await a.client.patch('/api/me/nickname', { nickname: 'santa' })).status).toBe(200);

    // 새 기기에서 코드로 재접속(구분 기호·소문자 허용)
    const other = new Client();
    const formatted = b.accessCode.toLowerCase().replace(/(.{4})(?=.)/g, '$1-');
    expect((await other.post('/api/access', { code: formatted })).status).toBe(200);
    const me = (await other.get('/api/me')).body;
    expect(me).toMatchObject({ nickname: '빨간코', goalText: '책 12권 읽기', submitStatus: 'DRAFT', rosterName: '나래' });

    // 목표가 비어 있으면 확정할 수 없다
    expect((await a.client.post('/api/me/submit', { nickname: 'santa', goalText: '' })).status).toBe(400);
    // 화면 내용이 저장된 값과 다르면 확정하지 않는다
    expect((await b.client.post('/api/me/submit', { nickname: '빨간코', goalText: '다른 내용' })).body.error.code).toBe('CONTENT_CHANGED');
    expect((await rows(`SELECT 1 FROM participants WHERE submit_status = 'SUBMITTED'`))).toHaveLength(0);
  });

  it('확정 후에는 닉네임·목표를 수정할 수 없고, 관리자 확정 해제 후 다시 수정할 수 있다', async () => {
    const admin = await openEvent(['가람', '나래', '다온']);
    const [a] = await registerAll(['가람', '나래', '다온']);
    expect((await submit(a!)).body).toEqual({ submitted: true, eventStatus: 'OPEN' });
    expect((await submit(a!)).status).toBe(200); // 재전송은 성공 처리

    expect((await a!.client.patch('/api/me/goal', { goalText: '바꾸기' })).body.error.code).toBe('ALREADY_SUBMITTED');
    expect((await a!.client.patch('/api/me/nickname', { nickname: '새별명' })).body.error.code).toBe('ALREADY_SUBMITTED');

    const id = await admin.participantId('가람');
    expect((await admin.op('POST', `/api/admin/participants/${id}/unsubmit`)).status).toBe(200);
    expect((await a!.client.patch('/api/me/nickname', { nickname: '새별명' })).status).toBe(200);
    expect((await a!.client.patch('/api/me/goal', { goalText: '바꾼 목표' })).status).toBe(200);
    expect((await a!.client.get('/api/me')).body).toMatchObject({ nickname: '새별명', goalText: '바꾼 목표', submitStatus: 'DRAFT' });
  });

  it('마감 후에는 등록·수정·확정이 모두 차단되고 연장하면 다시 가능하다', async () => {
    const admin = await openEvent(['가람', '나래', '다온']);
    const a = await register('가람');
    await setDeadlinePassed();

    expect((await a.client.patch('/api/me/goal', { goalText: '늦은 수정' })).body.error.code).toBe('DEADLINE_PASSED');
    expect((await a.client.patch('/api/me/nickname', { nickname: '늦은별명' })).body.error.code).toBe('DEADLINE_PASSED');
    expect((await submit(a)).body.error.code).toBe('DEADLINE_PASSED');
    const late = new Client();
    const option = (await late.get('/api/roster')).body.roster.find((item: any) => item.available);
    expect((await late.post('/api/participants', { rosterId: option.id, nickname: '지각생', goalText: '' })).body.error.code).toBe('DEADLINE_PASSED');

    // 마감 연장
    expect((await admin.patch('/api/admin/settings', { name: '송년회', budgetNote: '', deadlineAt: futureIso() })).status).toBe(200);
    expect((await submit(a)).status).toBe(200);
  });

  it('등록 초기화는 닉네임·목표·코드·세션을 무효화하고 닉네임을 다시 쓸 수 있게 한다', async () => {
    const admin = await openEvent(['가람', '나래']);
    const a = await register('가람', '루돌프');
    const id = await admin.participantId('가람');

    // 등록한 사람의 이름은 바꿀 수 없다
    expect((await admin.op('PATCH', `/api/admin/roster/${await admin.rosterId('가람')}`, { displayName: '가람2' })).body.error.code).toBe('REGISTERED');

    expect((await admin.op('POST', `/api/admin/participants/${id}/reset`)).status).toBe(200);
    expect((await a.client.get('/api/me')).status).toBe(401);
    expect((await new Client().post('/api/access', { code: a.accessCode })).status).toBe(401);
    expect(await count('sessions')).toBe(1); // 관리자 세션만 남는다

    const b = await register('나래', '루돌프'); // 초기화된 닉네임 재사용
    expect(b.accessCode).not.toBe(a.accessCode);
    const again = await register('가람', '새사람');
    expect((await again.client.get('/api/me')).body.goalText).toBe(goalFor('가람'));
  });
});

describe('참여 비밀번호', () => {
  it('관리자가 발급한 비밀번호가 이름과 맞아야만 등록된다', async () => {
    const admin = await openEvent(['가람', '나래', '다온']);
    const roster = (await new Client().get('/api/roster')).body.roster;
    const idOf = (name: string) => roster.find((item: any) => item.name === name).id as number;
    let attempt = 0;
    const post = (name: string, inviteCode?: unknown, nickname = `별명${name}`) => {
      const client = new Client();
      client.ip = `192.0.2.${++attempt}`; // 시도 제한에 걸리지 않도록 요청마다 다른 IP
      return client.post('/api/participants', { rosterId: idOf(name), nickname, goalText: '', inviteCode });
    };

    // 발급 전에는 누구도 등록할 수 없다
    expect((await post('가람')).body.error.code).toBe('INVALID_INVITE');
    expect((await post('가람', 'ABCDEFGH')).body.error.code).toBe('INVALID_INVITE');

    const garam = await inviteFor('가람');
    const narae = await inviteFor('나래');
    expect(garam).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(garam).not.toBe(narae);

    // 틀린 값·형식 오류·다른 사람의 비밀번호는 모두 거부되고 아무것도 저장되지 않는다
    for (const wrong of ['ABCDEFGH', '', 'short', 12345678, null, narae]) {
      const result = await post('가람', wrong);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('INVALID_INVITE');
      expect(result.setCookies).toEqual([]);
    }
    expect(await count('participants')).toBe(0);
    expect(await count('sessions')).toBe(1); // 관리자 세션만

    // 맞는 비밀번호(소문자·구분 기호 허용)로 등록되고, 사용한 비밀번호는 폐기된다
    const formatted = `${garam.slice(0, 4).toLowerCase()}-${garam.slice(4).toLowerCase()}`;
    const ok = await post('가람', formatted);
    expect(ok.status).toBe(201);
    expect((await rows('SELECT invite_hash FROM roster WHERE display_name = ?1', '가람'))[0]!.invite_hash).toBeNull();
    expect((await post('가람', garam, '또다른별명')).body.error.code).toBe('NAME_TAKEN');

    // 재발급하면 이전 비밀번호는 즉시 무효
    const naraeNew = await inviteFor('나래');
    expect((await post('나래', narae)).body.error.code).toBe('INVALID_INVITE');
    expect((await post('나래', naraeNew)).status).toBe(201);

    // 등록 초기화 후에는 예전 비밀번호로 다시 등록할 수 없고 새로 발급받아야 한다
    const id = await admin.participantId('가람');
    expect((await admin.op('POST', `/api/admin/participants/${id}/reset`)).status).toBe(200);
    expect((await post('가람', garam)).body.error.code).toBe('INVALID_INVITE');
    expect((await post('가람', await inviteFor('가람'))).status).toBe(201);
  });

  it('일괄 발급은 미발급자에게만 발급하고, 원문은 저장·조회되지 않는다', async () => {
    const admin = await openEvent(['가람', '나래', '다온', '라온']);
    const first = await inviteFor('가람');
    await register('나래');

    const bulk = await admin.post('/api/admin/invites');
    expect(bulk.status).toBe(200);
    expect(bulk.body.invites.map((item: any) => item.name).sort()).toEqual(['다온', '라온']); // 가람(발급됨)·나래(등록됨) 제외
    for (const item of bulk.body.invites) expect(Object.keys(item).sort()).toEqual(['inviteCode', 'name', 'rosterId']);
    expect((await admin.post('/api/admin/invites')).body.invites).toEqual([]); // 다시 눌러도 기존 비밀번호 유지

    const codes = [first, ...bulk.body.invites.map((item: any) => item.inviteCode as string)];
    const dashboard = await admin.dashboard();
    const exposed = JSON.stringify([dashboard, await rows('SELECT * FROM roster'), (await new Client().get('/api/roster')).body]);
    for (const code of codes) expect(exposed).not.toContain(code);
    expect(dashboard.roster.map((row) => [row.name, row.inviteIssued])).toEqual([
      ['가람', true],
      ['나래', false],
      ['다온', true],
      ['라온', true],
    ]);

    // 일괄 발급된 비밀번호로 등록할 수 있다
    const daon = bulk.body.invites.find((item: any) => item.name === '다온');
    const result = await new Client().post('/api/participants', { rosterId: daon.rosterId, nickname: '다온별명', goalText: '', inviteCode: daon.inviteCode });
    expect(result.status).toBe(201);

    // 권한·단계 제한
    expect((await new Client().post('/api/admin/invites')).status).toBe(401);
    expect((await admin.post(`/api/admin/roster/${daon.rosterId}/invite`)).status).toBe(409); // 이미 등록한 사람
    expect((await admin.post('/api/admin/roster/99999/invite')).status).toBe(409);
  });

  it('참여 비밀번호 실패가 누적되면 등록 시도가 차단된다', async () => {
    await openEvent(['가람', '나래']);
    const invite = await inviteFor('가람');
    const rosterId = (await new Client().get('/api/roster')).body.roster.find((item: any) => item.name === '가람').id;
    const attacker = new Client();
    attacker.ip = '198.51.100.9';
    for (let i = 0; i < 10; i++) {
      expect((await attacker.post('/api/participants', { rosterId, nickname: '침입자', goalText: '', inviteCode: 'ABCDEFGH' })).status).toBe(403);
    }
    expect((await attacker.post('/api/participants', { rosterId, nickname: '침입자', goalText: '', inviteCode: invite })).status).toBe(429);
    // 다른 IP 의 정상 참여자는 영향받지 않는다
    expect((await new Client().post('/api/participants', { rosterId, nickname: '진짜가람', goalText: '', inviteCode: invite })).status).toBe(201);
  });
});

describe('자동 매칭과 배정 열람', () => {
  it('전원 확정 시 자동 매칭되고 응답에는 배정 결과가 없다', async () => {
    const rosterNames = names(5);
    await openEvent(rosterNames);
    const members = await registerAll(rosterNames);
    for (const member of members.slice(0, 4)) expect((await submit(member)).body.eventStatus).toBe('OPEN');
    expect(await count('assignments')).toBe(0);

    const last = await submit(members[4]!);
    expect(last.body).toEqual({ submitted: true, eventStatus: 'MATCHED' });
    await expectValidStoredMatch(5);

    // /api/me 에는 상대 정보가 없다
    const me = (await members[0]!.client.get('/api/me')).body;
    expect(Object.keys(me).sort()).toEqual(['assignmentViewed', 'csrfToken', 'event', 'goalText', 'nickname', 'rosterName', 'submitStatus']);
    expect(me.assignmentViewed).toBe(false);
    expect(me.event.status).toBe('MATCHED');
  });

  it('배정 확인은 열람을 기록하고 받는 사람의 닉네임·목표·번호와 내 번호만 반환한다', async () => {
    const { members } = await matchedEvent(5);
    expect(await rows('SELECT 1 FROM assignments WHERE viewed_at IS NOT NULL')).toHaveLength(0);

    const me = members[0]!;
    const result = await view(me);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['assignedGoalText', 'myGiftNumber', 'receiverGiftNumber', 'receiverNickname']);

    // DB 의 배정과 일치하는지 확인
    const [stored] = await rows(
      `SELECT rp.nickname, rp.goal_text, rg.number AS receiver_number, mg.number AS my_number, a.viewed_at
         FROM assignments a
         JOIN participants sp ON sp.id = a.santa_id
         JOIN participants rp ON rp.id = a.receiver_id
         JOIN gift_numbers rg ON rg.participant_id = a.receiver_id
         JOIN gift_numbers mg ON mg.participant_id = a.santa_id
        WHERE sp.nickname = ?1`,
      me.nickname,
    );
    expect(result.body).toEqual({
      receiverNickname: stored!.nickname,
      assignedGoalText: stored!.goal_text,
      receiverGiftNumber: stored!.receiver_number,
      myGiftNumber: stored!.my_number,
    });
    expect(stored!.viewed_at).not.toBeNull();
    expect(result.body.receiverNickname).not.toBe(me.nickname);

    // 직접 입력한 닉네임이 그대로 표시되고, 명단 이름·다른 사람 목표는 섞이지 않는다
    const receiver = members.find((member) => member.nickname === result.body.receiverNickname)!;
    expect(result.body.assignedGoalText).toBe(receiver.goal);
    const serialized = JSON.stringify(result.body);
    for (const member of members) {
      if (member !== receiver) expect(serialized).not.toContain(member.goal);
    }

    // 새로 고침해도 같은 결과, 첫 열람 시각 유지
    const again = await view(me);
    expect(again.body).toEqual(result.body);
    const [after] = await rows('SELECT a.viewed_at FROM assignments a JOIN participants p ON p.id = a.santa_id WHERE p.nickname = ?1', me.nickname);
    expect(after!.viewed_at).toBe(stored!.viewed_at);
    expect((await me.client.get('/api/me')).body.assignmentViewed).toBe(true);
    expect(await rows('SELECT 1 FROM assignments WHERE viewed_at IS NOT NULL')).toHaveLength(1);
  });

  it('매칭 전에는 배정을 열람할 수 없다', async () => {
    await openEvent(['가람', '나래']);
    const a = await register('가람');
    await submit(a);
    expect(((await view(a)).body as any).error.code).toBe('NOT_MATCHED');
  });

  it('명단 제외로 전원 확정 상태가 되면 자동 매칭된다', async () => {
    const admin = await openEvent(['가람', '나래', '다온', '라온']);
    const [a, b, c] = await registerAll(['가람', '나래', '다온']);
    await submit(a!);
    await submit(b!);
    // 확정 제출자는 제외할 수 없다
    expect((await admin.op('DELETE', `/api/admin/roster/${await admin.rosterId('가람')}`)).body.error.code).toBe('SUBMITTED');
    // 미확정 등록자를 제외하면 닉네임·목표·접속 권한이 삭제된다
    expect((await admin.op('DELETE', `/api/admin/roster/${await admin.rosterId('다온')}`)).body.eventStatus).toBe('OPEN');
    expect((await c!.client.get('/api/me')).status).toBe(401);
    expect(await rows('SELECT 1 FROM participants WHERE nickname = ?1', nicknameFor('다온'))).toHaveLength(0);
    // 마지막 미등록자를 제외하면 남은 두 명으로 매칭
    expect((await admin.op('DELETE', `/api/admin/roster/${await admin.rosterId('라온')}`)).body.eventStatus).toBe('MATCHED');
    await expectValidStoredMatch(2);
  });
});

describe('관리자 운영', () => {
  it('마감 후 수동 매칭은 미확정자 제외와 매칭을 함께 처리한다', async () => {
    const admin = await openEvent(['가람', '나래', '다온', '라온', '마루']);
    const [a, b, c, d] = await registerAll(['가람', '나래', '다온', '라온']);
    await submit(a!);
    await submit(b!);
    await submit(c!);

    expect((await admin.op('POST', '/api/admin/match')).body.error.code).toBe('BEFORE_DEADLINE');
    await setDeadlinePassed();
    expect((await admin.op('POST', '/api/admin/match')).status).toBe(200);

    await expectValidStoredMatch(3);
    const dashboard = await admin.dashboard();
    expect(dashboard.event.status).toBe('MATCHED');
    expect(dashboard.counts).toMatchObject({ active: 3, registered: 3, submitted: 3 });
    expect(dashboard.roster.filter((row) => !row.active).map((row) => row.name).sort()).toEqual(['라온', '마루']);
    // 제외된 미확정자의 등록 정보와 접속 권한은 삭제된다
    expect((await d!.client.get('/api/me')).status).toBe(401);
    expect((await new Client().post('/api/access', { code: d!.accessCode })).status).toBe(401);
    expect(await count('participants')).toBe(3);
    expect((await admin.op('POST', '/api/admin/match')).status).toBe(200); // 재전송
  });

  it('확정 제출자가 2명 미만이면 수동 매칭할 수 없다', async () => {
    const admin = await openEvent(['가람', '나래']);
    await submit(await register('가람'));
    await setDeadlinePassed();
    expect((await admin.op('POST', '/api/admin/match')).body.error.code).toBe('NOT_ENOUGH');
    expect((await eventRow()).status).toBe('OPEN');
  });

  it('MATCHED 이후에는 명단·설정·등록이 잠긴다', async () => {
    const { admin, members } = await matchedEvent(3);
    expect((await admin.patch('/api/admin/settings', { name: '변경', budgetNote: '', deadlineAt: futureIso() })).body.error.code).toBe('INVALID_STATE');
    expect((await admin.op('POST', '/api/admin/roster', { names: ['새사람'] })).body.error.code).toBe('INVALID_STATE');
    const dashboard = await admin.dashboard();
    expect((await admin.op('DELETE', `/api/admin/roster/${dashboard.roster[0]!.id}`)).body.error.code).toBe('INVALID_STATE');
    const pid = dashboard.roster[0]!.participant!.id;
    expect((await admin.op('POST', `/api/admin/participants/${pid}/unsubmit`)).body.error.code).toBe('INVALID_STATE');
    expect((await admin.op('POST', `/api/admin/participants/${pid}/reset`)).body.error.code).toBe('INVALID_STATE');
    expect((await members[0]!.client.patch('/api/me/goal', { goalText: '변경' })).body.error.code).toBe('NOT_OPEN');
    expect((await members[0]!.client.patch('/api/me/nickname', { nickname: '변경별명' })).body.error.code).toBe('NOT_OPEN');
    expect((await new Client().get('/api/roster')).status).toBe(409);
    expect((await new Client().post('/api/participants', { rosterId: dashboard.roster[0]!.id, nickname: '난입', goalText: '' })).body.error.code).toBe('NOT_OPEN');
  });

  it('종료 → 공개 → 결과 조회, 단계별 제한', async () => {
    const { admin, members } = await matchedEvent(4);
    const me = members[0]!;
    const before = (await view(me)).body;

    expect((await admin.post('/api/admin/reveal')).body.error.code).toBe('INVALID_STATE'); // CLOSED 전 공개 차단
    expect((await me.client.get('/api/results')).status).toBe(403);
    expect((await admin.get('/api/results')).status).toBe(403);

    expect((await admin.post('/api/admin/close')).status).toBe(200);
    expect((await admin.post('/api/admin/close')).status).toBe(200); // 재전송
    expect((await admin.post('/api/admin/rematch')).body.error.code).toBe('INVALID_STATE');
    expect((await me.client.get('/api/results')).status).toBe(403); // 종료만으로는 공개되지 않는다
    expect((await admin.get('/api/results')).status).toBe(403); // 관리자 사전 미리보기 없음
    expect((await view(me)).body).toEqual(before); // 종료 후에도 기존 배정 열람

    let dashboard = await admin.dashboard();
    expect(Date.parse(dashboard.event.deleteDueAt!) - Date.parse(dashboard.event.closedAt!)).toBe(7 * 24 * 60 * 60 * 1000);

    expect((await admin.post('/api/admin/reveal')).status).toBe(200);
    const revealedAt = (await eventRow()).revealed_at;
    expect((await admin.post('/api/admin/reveal')).status).toBe(200); // 재전송해도 공개 시각 유지
    expect((await eventRow()).revealed_at).toBe(revealedAt);
    dashboard = await admin.dashboard();
    expect(Date.parse(dashboard.event.deleteDueAt!) - Date.parse(revealedAt)).toBe(7 * 24 * 60 * 60 * 1000);

    expect((await new Client().get('/api/results')).status).toBe(401); // 인증 필요
    for (const client of [me.client, admin]) {
      const results = await client.get('/api/results');
      expect(results.status).toBe(200);
      expect(Object.keys(results.body).sort()).toEqual(['eventName', 'pairs']);
      expect(results.body.pairs).toHaveLength(4);
      for (const pair of results.body.pairs) expect(Object.keys(pair).sort()).toEqual(['receiverNickname', 'santaNickname']);
      const serialized = JSON.stringify(results.body);
      for (const member of members) {
        expect(serialized).toContain(member.nickname);
        expect(serialized).not.toContain(member.goal); // 목표 제외
        expect(serialized).not.toContain(`"${member.name}"`); // 명단 이름 제외
      }
      // 내 배정이 공개 목록과 같은 닉네임으로 표시된다
      expect(results.body.pairs).toContainEqual({ santaNickname: me.nickname, receiverNickname: before.receiverNickname });
    }
    expect(JSON.stringify((await me.client.get('/api/event')).body)).toContain('"revealed":true');
  });
});
