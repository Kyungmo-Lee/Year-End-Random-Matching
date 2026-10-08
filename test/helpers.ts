import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import type { AdminDashboard, AssignmentView } from '../src/shared/types';
import worker from '../src/worker/index';

export const ORIGIN = 'https://gift.test';
export const db = () => env.DB;

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_assignments'),
    env.DB.prepare('DELETE FROM assignments'),
    env.DB.prepare('DELETE FROM gift_numbers'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM participants'),
    env.DB.prepare('DELETE FROM roster'),
    env.DB.prepare('DELETE FROM auth_attempts'),
    env.DB.prepare('DELETE FROM event'),
    env.DB.prepare('INSERT INTO event (id) VALUES (1)'),
  ]);
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
  setCookies: string[];
}

/** 쿠키와 CSRF 토큰을 기억하는 테스트용 브라우저. 실제 Worker 의 fetch 핸들러를 호출한다. */
export class Client {
  cookies = new Map<string, string>();
  csrf: string | undefined;
  ip = '203.0.113.10';

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    options: { origin?: string | null; csrf?: string | null } = {},
  ): Promise<ApiResult<T>> {
    const headers = new Headers({ 'CF-Connecting-IP': this.ip });
    if (this.cookies.size > 0) {
      headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    if (method !== 'GET') {
      const origin = options.origin === undefined ? ORIGIN : options.origin;
      if (origin !== null) headers.set('Origin', origin);
      const csrf = options.csrf === undefined ? this.csrf : options.csrf;
      if (csrf) headers.set('X-CSRF-Token', csrf);
      headers.set('Content-Type', 'application/json');
    }
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const response = await worker.fetch(request as never, env as never);
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (value === '' || /Max-Age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const parsed = (await response.json()) as any;
    if (parsed && typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
    return { status: response.status, body: parsed, headers: response.headers, setCookies };
  }

  get = <T = any>(path: string) => this.request<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.request<T>('POST', path, body);
  patch = <T = any>(path: string, body?: unknown) => this.request<T>('PATCH', path, body);
  delete = <T = any>(path: string, body?: unknown) => this.request<T>('DELETE', path, body);
}

export class AdminClient extends Client {
  async dashboard(): Promise<AdminDashboard> {
    const result = await this.get<AdminDashboard>('/api/admin/dashboard');
    expect(result.status).toBe(200);
    return result.body;
  }

  /** 현재 revision 을 읽어 expectedRevision 과 함께 보낸다. */
  async op(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
    const { event } = await this.dashboard();
    return this.request(method, path, { ...body, expectedRevision: event.revision });
  }

  async participantId(rosterName: string): Promise<number> {
    const row = (await this.dashboard()).roster.find((item) => item.name === rosterName);
    return row!.participant!.id;
  }

  async rosterId(rosterName: string): Promise<number> {
    return (await this.dashboard()).roster.find((item) => item.name === rosterName)!.id;
  }
}

export async function loginAdmin(): Promise<AdminClient> {
  const admin = new AdminClient();
  const result = await admin.post('/api/admin/login', { password: env.TEST_ADMIN_PASSWORD });
  expect(result.status).toBe(200);
  return admin;
}

export const futureIso = (ms = 24 * 60 * 60 * 1000) => new Date(Date.now() + ms).toISOString();

export function names(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `참석자${String(i + 1).padStart(2, '0')}`);
}

/** 관리자 로그인 → 설정 → 명단 → 참여 시작. */
export async function openEvent(rosterNames: string[], eventName = '송년회'): Promise<AdminClient> {
  const admin = await loginAdmin();
  expect((await admin.patch('/api/admin/settings', { name: eventName, budgetNote: '2만원 내외', deadlineAt: futureIso() })).status).toBe(200);
  expect((await admin.op('POST', '/api/admin/roster', { names: rosterNames })).status).toBe(201);
  expect((await admin.op('POST', '/api/admin/start')).status).toBe(200);
  currentAdmin = admin;
  return admin;
}

// 가장 최근에 openEvent 로 연 행사의 관리자. register() 가 참여 비밀번호를 발급받는 데 쓴다.
let currentAdmin: AdminClient | null = null;

/** 관리자가 그 사람의 참여 비밀번호를 (재)발급해 전달하는 과정. */
export async function inviteFor(name: string, admin: AdminClient | null = currentAdmin): Promise<string> {
  const rosterId = await admin!.rosterId(name);
  const result = await admin!.post(`/api/admin/roster/${rosterId}/invite`);
  expect(result.status).toBe(200);
  return result.body.invites[0].inviteCode;
}

export interface Member {
  name: string;
  nickname: string;
  goal: string;
  client: Client;
  accessCode: string;
}

export const nicknameFor = (name: string) => `별명-${name}`;
export const goalFor = (name: string) => `${name}의 새해 목표: 매일 30분 걷기`;

export async function register(name: string, nickname = nicknameFor(name), goal = goalFor(name)): Promise<Member> {
  const client = new Client();
  const roster = await client.get('/api/roster');
  const option = roster.body.roster.find((item: { name: string }) => item.name === name);
  const inviteCode = await inviteFor(name);
  const result = await client.post('/api/participants', { rosterId: option.id, nickname, goalText: goal, inviteCode });
  expect(result.status).toBe(201);
  return { name, nickname, goal, client, accessCode: result.body.accessCode };
}

export function submit(member: Member): Promise<ApiResult> {
  return member.client.post('/api/me/submit', { nickname: member.nickname, goalText: member.goal });
}

export async function registerAll(rosterNames: string[]): Promise<Member[]> {
  const members: Member[] = [];
  for (const name of rosterNames) members.push(await register(name));
  return members;
}

/** 참여 시작 후 전원 등록·확정까지 진행해 MATCHED 상태를 만든다. */
export async function matchedEvent(count: number): Promise<{ admin: AdminClient; members: Member[] }> {
  const rosterNames = names(count);
  const admin = await openEvent(rosterNames);
  const members = await registerAll(rosterNames);
  for (const member of members) expect((await submit(member)).status).toBe(200);
  expect((await eventRow()).status).toBe('MATCHED');
  return { admin, members };
}

export function view(member: Member): Promise<ApiResult<AssignmentView>> {
  return member.client.post<AssignmentView>('/api/me/assignment/view');
}

export async function eventRow(): Promise<Record<string, any>> {
  return (await env.DB.prepare('SELECT * FROM event WHERE id = 1').first())!;
}

export async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

export async function rows<T = Record<string, any>>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

export async function setDeadlinePassed(): Promise<void> {
  await env.DB.prepare('UPDATE event SET deadline_at = ?1 WHERE id = 1').bind(new Date(Date.now() - 60_000).toISOString()).run();
}

/** 매칭 저장 batch 의 중간(배정 INSERT)에서 SQL 오류가 나도록 만든다. */
export async function injectAssignmentFailure(): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER test_fail_assignments BEFORE INSERT ON assignments BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
  ).run();
}

export async function removeAssignmentFailure(): Promise<void> {
  await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_assignments').run();
}

export async function runCron(): Promise<void> {
  await worker.scheduled({ scheduledTime: Date.now() + 1, cron: '* * * * *', noRetry() {} } as never, env as never);
}

/** DB 에 저장된 매칭이 1:1·자기 배정 없음·단일 사이클·번호 유일성을 만족하는지 독립적으로 검사한다. */
export async function expectValidStoredMatch(expectedCount: number): Promise<void> {
  const event = await eventRow();
  const assignments = await rows<{ santa_id: number; receiver_id: number; match_run_id: string }>('SELECT * FROM assignments');
  const numbers = await rows<{ participant_id: number; number: number; match_run_id: string }>('SELECT * FROM gift_numbers');
  const active = await rows<{ id: number }>(
    `SELECT p.id FROM participants p JOIN roster r ON r.id = p.roster_id WHERE r.active = 1 AND p.submit_status = 'SUBMITTED'`,
  );
  expect(assignments).toHaveLength(expectedCount);
  expect(numbers).toHaveLength(expectedCount);
  expect(active).toHaveLength(expectedCount);
  expect(new Set(assignments.map((row) => row.match_run_id))).toEqual(new Set([event.match_run_id]));
  expect(new Set(numbers.map((row) => row.match_run_id))).toEqual(new Set([event.match_run_id]));

  const ids = new Set(active.map((row) => row.id));
  const next = new Map(assignments.map((row) => [row.santa_id, row.receiver_id]));
  expect(new Set(next.keys())).toEqual(ids);
  expect(new Set(next.values())).toEqual(ids);
  for (const [santa, receiver] of next) expect(santa).not.toBe(receiver);

  const start = assignments[0]!.santa_id;
  let cursor = start;
  let steps = 0;
  do {
    cursor = next.get(cursor)!;
    steps++;
  } while (cursor !== start && steps <= expectedCount);
  expect(steps).toBe(expectedCount);

  expect(new Set(numbers.map((row) => row.participant_id))).toEqual(ids);
  expect(new Set(numbers.map((row) => row.number)).size).toBe(expectedCount);
  for (const row of numbers) expect(row.number >= 1 && row.number <= 99).toBe(true);
}
