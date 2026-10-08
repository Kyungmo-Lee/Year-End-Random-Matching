import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminDashboard, AdminRosterRow, IssuedInvite } from '../shared/types';
import {
  cleanBudgetNote,
  cleanEventName,
  cleanRosterName,
  formatAccessCode,
  formatKst,
  kstInputToUtc,
  LIMITS,
  utcToKstInput,
} from '../shared/validation';
import { api, ApiError, errorMessage } from './api';
import { CopyButton, Dialog, isDeadlinePassed, Loading, Notice, Page, StatusBadge } from './components';
import { Link } from './router';

type Message = { kind: 'error' | 'success'; text: string } | null;

/** 확인 창 하나를 설명하는 값. run 이 성공하면 창을 닫고 현황을 새로 읽는다. */
interface PendingAction {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** 입력값이 이 문자열과 같아야 확인 버튼이 켜진다(데이터 삭제용). */
  requireText?: string;
  /** 자유 입력(이름 변경용) */
  input?: { label: string; initial: string };
  run: (input: string) => Promise<string | void>;
}

export function AdminPage() {
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingInput, setPendingInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState<{ name: string; code: string } | null>(null);
  const [issuedInvites, setIssuedInvites] = useState<IssuedInvite[] | null>(null);

  const load = useCallback(async () => {
    try {
      setDashboard(await api<AdminDashboard>('GET', '/api/admin/dashboard'));
      setNeedLogin(false);
      setLoadError(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setNeedLogin(true);
        setDashboard(null);
      } else setLoadError(errorMessage(reason));
    }
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!dashboard) return;
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [dashboard !== null, load]);

  /** 요청을 보내고 현황을 새로 읽는다. 현황이 바뀌어 거부되면(STALE) 새 현황을 보여 주고 다시 시도하게 한다. */
  const perform = useCallback(
    async (action: () => Promise<string | void>): Promise<boolean> => {
      setBusy(true);
      setMessage(null);
      try {
        const text = await action();
        setMessage({ kind: 'success', text: text ?? '반영했습니다.' });
        return true;
      } catch (reason) {
        setMessage({ kind: 'error', text: errorMessage(reason) });
        return false;
      } finally {
        await load();
        setBusy(false);
      }
    },
    [load],
  );

  const ask = (action: PendingAction) => {
    setPendingInput(action.input?.initial ?? '');
    setPending(action);
  };

  const confirmPending = async () => {
    if (!pending) return;
    const action = pending;
    await perform(() => action.run(pendingInput));
    setPending(null);
  };

  if (needLogin) return <LoginForm onDone={load} />;
  if (loadError && !dashboard) {
    return (
      <Page title="관리자" wide>
        <Notice kind="error">{loadError}</Notice>
      </Page>
    );
  }
  if (!dashboard) {
    return (
      <Page title="관리자" wide>
        <Loading />
      </Page>
    );
  }

  const { event, counts, roster } = dashboard;
  const revision = event.revision;
  const editable = event.status === 'SETUP' || event.status === 'OPEN';
  const deadlinePassed = isDeadlinePassed(event);
  const activeRows = roster.filter((row) => row.active);
  const isSubmitted = (row: AdminRosterRow) => row.participant?.submitStatus === 'SUBMITTED';

  const logout = () => perform(() => api('POST', '/api/logout', { role: 'admin' }, 'admin').then(() => '로그아웃했습니다.'));

  // ---- 명단 행 동작 ----

  const askRename = (row: AdminRosterRow) =>
    ask({
      title: '이름 변경',
      body: <p>아직 등록하지 않은 사람의 이름만 바꿀 수 있습니다.</p>,
      confirmLabel: '변경',
      input: { label: '새 이름', initial: row.name },
      run: async (input) => {
        const cleaned = cleanRosterName(input);
        if (!cleaned.ok) throw new ApiError(400, 'INVALID_INPUT', cleaned.message);
        await api('PATCH', `/api/admin/roster/${row.id}`, { displayName: cleaned.value.displayName, expectedRevision: revision });
        return '이름을 변경했습니다.';
      },
    });

  const askExclude = (row: AdminRosterRow) => {
    const rest = activeRows.filter((item) => item.id !== row.id);
    const triggersMatch = event.status === 'OPEN' && rest.length >= 2 && rest.every(isSubmitted);
    ask({
      title: `${row.name} 님을 명단에서 제외할까요?`,
      danger: true,
      confirmLabel: triggersMatch ? '제외하고 매칭 실행' : '제외',
      body: (
        <>
          {row.participant && <p>이 사람의 닉네임({row.participant.nickname})·임시 목표·접속 권한도 함께 삭제됩니다.</p>}
          {triggersMatch && (
            <Notice kind="warn">
              제외하면 남은 {rest.length}명 전원이 확정 상태가 되어 <strong>즉시 자동 매칭</strong>이 실행됩니다. 매칭 후에는 명단을 바꿀
              수 없습니다.
              {rest.length < LIMITS.smallGroup && ' 인원이 4명 미만이라 서로의 상대를 쉽게 추측할 수 있습니다.'}
            </Notice>
          )}
        </>
      ),
      run: async () => {
        const result = await api<{ eventStatus: string | null }>('DELETE', `/api/admin/roster/${row.id}`, { expectedRevision: revision });
        return result.eventStatus === 'MATCHED' ? '제외했고, 전원 확정 상태가 되어 매칭이 완료되었습니다.' : '명단에서 제외했습니다.';
      },
    });
  };

  const restore = (row: AdminRosterRow) =>
    perform(async () => {
      await api('PATCH', `/api/admin/roster/${row.id}`, { active: true, expectedRevision: revision });
      return '명단에 복원했습니다.';
    });

  // ---- 참여 비밀번호 ----

  const issueInvite = (row: AdminRosterRow) =>
    perform(async () => {
      const result = await api<{ invites: IssuedInvite[] }>('POST', `/api/admin/roster/${row.id}/invite`);
      setIssuedInvites(result.invites);
      return '참여 비밀번호를 발급했습니다.';
    });

  const askReissueInvite = (row: AdminRosterRow) =>
    ask({
      title: `${row.name} 님의 참여 비밀번호를 다시 발급할까요?`,
      confirmLabel: '재발급',
      body: <p>이전에 전달한 참여 비밀번호는 즉시 쓸 수 없게 됩니다. 새 비밀번호를 본인에게 다시 전달해 주세요.</p>,
      run: async () => {
        const result = await api<{ invites: IssuedInvite[] }>('POST', `/api/admin/roster/${row.id}/invite`);
        setIssuedInvites(result.invites);
        return '참여 비밀번호를 재발급했습니다.';
      },
    });

  const issueMissingInvites = () =>
    perform(async () => {
      const result = await api<{ invites: IssuedInvite[] }>('POST', '/api/admin/invites');
      if (result.invites.length === 0) return '새로 발급할 사람이 없습니다. 이미 모두 발급되었거나 등록을 마쳤습니다.';
      setIssuedInvites(result.invites);
      return `${result.invites.length}명의 참여 비밀번호를 발급했습니다.`;
    });

  const askRemove = (row: AdminRosterRow) =>
    ask({
      title: `${row.name} 을(를) 명단에서 완전히 삭제할까요?`,
      danger: true,
      confirmLabel: '삭제',
      body: <p>제외된 이름을 목록에서 지웁니다. 다시 필요하면 새로 추가하면 됩니다.</p>,
      run: async () => {
        await api('DELETE', `/api/admin/roster/${row.id}`, { permanent: true, expectedRevision: revision });
        return '명단에서 삭제했습니다.';
      },
    });

  const askReset = (row: AdminRosterRow) =>
    ask({
      title: `${row.name} 님의 등록을 초기화할까요?`,
      danger: true,
      confirmLabel: '등록 초기화',
      body: (
        <p>
          닉네임({row.participant?.nickname})·목표·접속 코드가 삭제되고 접속 중인 기기에서도 로그아웃됩니다. 되돌릴 수 없으며, 본인이
          다시 등록해야 합니다.
        </p>
      ),
      run: async () => {
        await api('POST', `/api/admin/participants/${row.participant!.id}/reset`, { expectedRevision: revision });
        return '등록을 초기화했습니다.';
      },
    });

  const askUnsubmit = (row: AdminRosterRow) =>
    ask({
      title: `${row.name} 님의 확정을 해제할까요?`,
      confirmLabel: '확정 해제',
      body: <p>닉네임과 목표를 다시 수정할 수 있게 됩니다. 마감 전에 본인이 다시 확정 제출해야 매칭에 포함됩니다.</p>,
      run: async () => {
        await api('POST', `/api/admin/participants/${row.participant!.id}/unsubmit`, { expectedRevision: revision });
        return '확정을 해제했습니다.';
      },
    });

  const askReissue = (row: AdminRosterRow) =>
    ask({
      title: `${row.name} 님의 접속 코드를 재발급할까요?`,
      confirmLabel: '재발급',
      body: <p>기존 코드와 접속 중인 세션은 즉시 무효가 됩니다. 새 코드는 한 번만 표시되니 본인에게 직접 전달해 주세요.</p>,
      run: async () => {
        const result = await api<{ accessCode: string }>('POST', `/api/admin/participants/${row.participant!.id}/reissue-code`);
        setIssuedCode({ name: row.name, code: formatAccessCode(result.accessCode) });
        return '새 접속 코드를 발급했습니다.';
      },
    });

  // ---- 단계별 운영 ----

  const askStart = () =>
    ask({
      title: '참여를 시작할까요?',
      confirmLabel: '참여 시작',
      body: (
        <>
          <p>
            <strong>{event.name}</strong> · 마감 {formatKst(event.deadlineAt)} · 참석자 {counts.active}명
          </p>
          <p>시작하면 참여 링크에서 명단이 보이고 등록할 수 있습니다.</p>
          {counts.active < LIMITS.smallGroup && (
            <Notice kind="warn">참석자가 4명 미만이면 선택 가능한 상대가 적어 서로의 상대를 쉽게 추측할 수 있습니다.</Notice>
          )}
        </>
      ),
      run: async () => {
        await api('POST', '/api/admin/start', { expectedRevision: revision });
        return '참여를 시작했습니다. 참여 링크를 공유해 주세요.';
      },
    });

  const askForceMatch = () => {
    const excluded = activeRows.filter((row) => !isSubmitted(row));
    ask({
      title: '미확정자를 제외하고 매칭할까요?',
      danger: true,
      confirmLabel: `${counts.submitted}명으로 매칭`,
      body: (
        <>
          <p>
            확정 제출한 <strong>{counts.submitted}명</strong>만으로 매칭합니다. 매칭 후에는 명단·목표를 바꿀 수 없습니다.
          </p>
          {excluded.length > 0 && (
            <p>
              제외되는 사람({excluded.length}명): {excluded.map((row) => row.name).join(', ')} — 등록 정보와 접속 권한이 삭제됩니다.
            </p>
          )}
          {counts.submitted < LIMITS.smallGroup && (
            <Notice kind="warn">4명 미만으로 매칭하면 서로의 상대를 쉽게 추측할 수 있습니다.</Notice>
          )}
        </>
      ),
      run: async () => {
        await api('POST', '/api/admin/match', { expectedRevision: revision });
        return '매칭을 완료했습니다.';
      },
    });
  };

  const askRematch = () =>
    ask({
      title: '다시 매칭할까요?',
      danger: true,
      confirmLabel: '재매칭',
      body: <p>아직 아무도 배정을 확인하지 않았습니다. 배정과 선물 번호가 모두 새로 정해집니다.</p>,
      run: async () => {
        await api('POST', '/api/admin/rematch');
        return '재매칭했습니다.';
      },
    });

  const askClose = () =>
    ask({
      title: '행사를 종료할까요?',
      confirmLabel: '행사 종료',
      body: (
        <p>
          종료하면 재매칭할 수 없습니다. 참여자는 계속 자신의 배정을 볼 수 있고, 종료 후 전체 결과를 공개하거나 데이터를 삭제할 수
          있습니다. 미열람 {counts.active - counts.viewed}명.
        </p>
      ),
      run: async () => {
        await api('POST', '/api/admin/close');
        return '행사를 종료했습니다. 7일 이내에 데이터를 삭제해 주세요.';
      },
    });

  const askReveal = () =>
    ask({
      title: '전체 결과를 공개할까요?',
      danger: true,
      confirmLabel: '공개',
      body: (
        <p>
          모든 참여자가 <strong>산타 닉네임 → 받는 사람 닉네임</strong> 전체 목록을 볼 수 있게 됩니다. 목표 내용과 실제 이름은
          공개되지 않습니다. <strong>공개는 취소할 수 없습니다.</strong>
        </p>
      ),
      run: async () => {
        await api('POST', '/api/admin/reveal');
        return '전체 결과를 공개했습니다.';
      },
    });

  const askDelete = () =>
    ask({
      title: '모든 참여 데이터를 삭제할까요?',
      danger: true,
      confirmLabel: '영구 삭제',
      requireText: event.name,
      input: { label: `확인을 위해 행사명 “${event.name}” 을 입력해 주세요`, initial: '' },
      body: (
        <p>
          명단·닉네임·목표·배정·선물 번호·접속 코드·참여자 세션이 모두 삭제되고 <strong>복구할 수 없습니다.</strong> 삭제 후에는 이
          주소로 다시 참여하거나 조회할 수 없습니다.
        </p>
      ),
      run: async (input) => {
        await api('DELETE', '/api/admin/data', { confirmName: input });
        return '모든 참여 데이터를 삭제했습니다.';
      },
    });

  const askNewEvent = () =>
    ask({
      title: '새 행사를 준비할까요?',
      confirmLabel: '새 행사 준비',
      body: (
        <p>
          빈 상태의 새 행사를 ‘준비 중’ 단계로 엽니다. 이전 행사의 명단·닉네임·목표·배정·접속 코드는 이미 삭제되어 이어지지 않으며,
          행사명·마감·명단을 처음부터 다시 설정합니다. 참여 링크와 관리자 비밀번호는 그대로입니다.
        </p>
      ),
      run: async () => {
        await api('POST', '/api/admin/new-event');
        return '새 행사를 준비 상태로 열었습니다. 행사 설정과 명단을 입력해 주세요.';
      },
    });

  const deleteOverdue = event.deleteDueAt !== null && Date.parse(event.deleteDueAt) <= Date.parse(event.serverTime);
  const participantUrl = `${window.location.origin}/`;

  return (
    <Page title="관리자" wide>
      <section className="card">
        <div className="card-head">
          <StatusBadge status={event.status} />
          <button type="button" className="btn btn-ghost btn-small" onClick={logout}>
            로그아웃
          </button>
        </div>
        <h1>{event.status === 'DELETED' ? '행사 데이터 삭제 완료' : event.name || '행사 설정 전'}</h1>
        {event.status === 'DELETED' ? (
          <>
            <Notice kind="info">
              {formatKst(event.deletedAt)}에 모든 참여 데이터를 삭제했습니다. 과거 데이터를 복원하지 마세요. 다음 행사를 열려면 아래
              버튼으로 새 행사를 준비합니다.
            </Notice>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={askNewEvent} disabled={busy}>
                새 행사 준비
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="stats">
              <div>
                <dt>참석 인원</dt>
                <dd>{counts.active}명</dd>
              </div>
              <div>
                <dt>등록</dt>
                <dd>
                  {counts.registered}/{counts.active}
                </dd>
              </div>
              <div>
                <dt>확정 제출</dt>
                <dd>
                  {counts.submitted}/{counts.active}
                </dd>
              </div>
              {(event.status === 'MATCHED' || event.status === 'CLOSED') && (
                <div>
                  <dt>배정 열람</dt>
                  <dd>
                    {counts.viewed}/{counts.active}
                  </dd>
                </div>
              )}
            </dl>
            <dl className="summary">
              <div>
                <dt>마감</dt>
                <dd>
                  {event.deadlineAt ? `${formatKst(event.deadlineAt)} (한국 시각)` : '미설정'}
                  {event.status === 'OPEN' && deadlinePassed && ' — 마감됨'}
                </dd>
              </div>
              {event.matchedAt && (
                <div>
                  <dt>매칭 시각</dt>
                  <dd>{formatKst(event.matchedAt)}</dd>
                </div>
              )}
              {event.closedAt && (
                <div>
                  <dt>종료 시각</dt>
                  <dd>{formatKst(event.closedAt)}</dd>
                </div>
              )}
              {event.status === 'CLOSED' && (
                <div>
                  <dt>결과 공개</dt>
                  <dd>{event.revealedAt ? formatKst(event.revealedAt) : '비공개'}</dd>
                </div>
              )}
            </dl>
            {event.status !== 'SETUP' && (
              <div className="share">
                <span>
                  참여 링크: <code>{participantUrl}</code>
                </span>
                <CopyButton text={participantUrl} label="링크 복사" />
              </div>
            )}
          </>
        )}
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>

      {event.status !== 'DELETED' && (
        <section className="card">
          <h2>진행 단계</h2>
          {event.status === 'SETUP' && (
            <>
              <p>행사 정보와 명단을 저장한 뒤 참여를 시작하세요. 시작 전에는 참여자에게 명단이 보이지 않습니다.</p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={askStart}
                  disabled={busy || !event.name || !event.deadlineAt || deadlinePassed || counts.active < LIMITS.rosterMin}
                >
                  참여 시작
                </button>
              </div>
              {(!event.name || !event.deadlineAt || deadlinePassed || counts.active < LIMITS.rosterMin) && (
                <p className="hint">행사명, 미래의 마감 일시, 참석자 2명 이상이 필요합니다.</p>
              )}
            </>
          )}
          {event.status === 'OPEN' && (
            <>
              <p>
                {counts.active >= 2 && counts.submitted === counts.active
                  ? '전원이 확정했습니다. 매칭을 처리하는 중이며 1분 안에 자동으로 완료됩니다.'
                  : '활성 명단 전원이 확정 제출하면 자동으로 매칭됩니다.'}
              </p>
              {deadlinePassed ? (
                <>
                  <Notice kind="warn">
                    마감이 지났습니다. 미확정 {counts.active - counts.submitted}명. 아래 ‘행사 설정’에서 마감을 연장하거나, 미확정자를
                    제외하고 매칭할 수 있습니다.
                  </Notice>
                  <div className="actions">
                    <button type="button" className="btn btn-danger" onClick={askForceMatch} disabled={busy || counts.submitted < 2}>
                      미확정자 제외 후 매칭
                    </button>
                  </div>
                  {counts.submitted < 2 && <p className="hint">확정 제출자가 2명 이상이어야 매칭할 수 있습니다.</p>}
                </>
              ) : (
                <p className="hint">수동 매칭(미확정자 제외)은 마감 이후에만 할 수 있습니다.</p>
              )}
            </>
          )}
          {event.status === 'MATCHED' && (
            <>
              <p>매칭이 완료되었습니다. 참여자는 내 페이지에서 배정을 확인합니다. 관리자도 공개 전에는 배정 내용을 볼 수 없습니다.</p>
              <div className="actions">
                <button type="button" className="btn btn-primary" onClick={askClose} disabled={busy}>
                  행사 종료
                </button>
                <button type="button" className="btn btn-secondary" onClick={askRematch} disabled={busy || counts.viewed > 0}>
                  재매칭
                </button>
              </div>
              {counts.viewed > 0 && <p className="hint">이미 배정을 확인한 참여자가 있어 재매칭할 수 없습니다.</p>}
            </>
          )}
          {event.status === 'CLOSED' && (
            <>
              <Notice kind={deleteOverdue ? 'error' : 'warn'}>
                데이터 삭제 기한: <strong>{formatKst(event.deleteDueAt)}</strong> ({event.revealedAt ? '공개일' : '종료일'}로부터 7일)
                {deleteOverdue && ' — 기한이 지났습니다. 지금 삭제해 주세요.'}
              </Notice>
              <div className="actions">
                {event.revealedAt ? (
                  <Link to="/results" className="btn btn-secondary">
                    전체 결과 보기
                  </Link>
                ) : (
                  <button type="button" className="btn btn-secondary" onClick={askReveal} disabled={busy}>
                    전체 결과 공개
                  </button>
                )}
                <button type="button" className="btn btn-danger" onClick={askDelete} disabled={busy}>
                  데이터 삭제
                </button>
              </div>
              {!event.revealedAt && <p className="hint">공개는 선택 사항이며, 공개 전에는 관리자도 전체 매칭을 볼 수 없습니다.</p>}
            </>
          )}
        </section>
      )}

      {editable && <SettingsForm dashboard={dashboard} perform={perform} busy={busy} />}
      {editable && <RosterAddForm revision={revision} perform={perform} busy={busy} />}

      {event.status !== 'DELETED' && (
        <section className="card">
          <h2>명단과 진행 현황</h2>
          <p className="hint">목표 내용·선물 번호·배정 상대는 이 화면에 표시되지 않습니다.</p>
          {editable && (
            <>
              <p className="hint">
                참여하려면 <strong>참여 비밀번호</strong>가 필요합니다. 사람마다 발급해 본인에게 직접 전달해 주세요. 비밀번호는 발급 직후
                한 번만 표시되며, 등록에 사용되면 폐기됩니다.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={issueMissingInvites}
                  disabled={busy || !activeRows.some((row) => !row.participant && !row.inviteIssued)}
                >
                  미발급자 전원 참여 비밀번호 발급
                </button>
              </div>
            </>
          )}
          {roster.length === 0 ? (
            <Notice kind="info">명단이 비어 있습니다. 위에서 참석자를 추가해 주세요.</Notice>
          ) : (
            <ul className="roster">
              {roster.map((row) => (
                <li key={row.id} className={row.active ? 'roster-row' : 'roster-row roster-row-inactive'}>
                  <div className="roster-main">
                    <span className="roster-name">{row.name}</span>
                    <span className="roster-nickname">{row.participant ? `닉네임: ${row.participant.nickname}` : ''}</span>
                  </div>
                  <div className="roster-state">
                    {!row.active ? (
                      <span className="chip chip-muted">제외됨</span>
                    ) : !row.participant ? (
                      <>
                        <span className="chip chip-muted">미등록</span>
                        {editable && (
                          <span className={row.inviteIssued ? 'chip chip-ok' : 'chip chip-warn'}>
                            {row.inviteIssued ? '비밀번호 발급됨' : '비밀번호 미발급'}
                          </span>
                        )}
                      </>
                    ) : row.participant.submitStatus === 'SUBMITTED' ? (
                      <span className="chip chip-ok">확정 제출</span>
                    ) : (
                      <span className="chip chip-warn">임시저장</span>
                    )}
                    {row.participant && (event.status === 'MATCHED' || event.status === 'CLOSED') && (
                      <span className={row.participant.viewed ? 'chip chip-ok' : 'chip chip-muted'}>
                        {row.participant.viewed ? '배정 열람' : '미열람'}
                      </span>
                    )}
                  </div>
                  <div className="roster-actions">
                    {editable && row.active && !row.participant && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askRename(row)} disabled={busy}>
                        이름 변경
                      </button>
                    )}
                    {editable && row.active && !row.participant && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => (row.inviteIssued ? askReissueInvite(row) : issueInvite(row))}
                        disabled={busy}
                      >
                        {row.inviteIssued ? '참여 비밀번호 재발급' : '참여 비밀번호 발급'}
                      </button>
                    )}
                    {editable && row.active && !isSubmitted(row) && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askExclude(row)} disabled={busy}>
                        제외
                      </button>
                    )}
                    {editable && !row.active && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => restore(row)} disabled={busy}>
                        복원
                      </button>
                    )}
                    {editable && !row.active && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askRemove(row)} disabled={busy}>
                        삭제
                      </button>
                    )}
                    {event.status === 'OPEN' && isSubmitted(row) && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askUnsubmit(row)} disabled={busy}>
                        확정 해제
                      </button>
                    )}
                    {event.status === 'OPEN' && row.participant && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askReset(row)} disabled={busy}>
                        등록 초기화
                      </button>
                    )}
                    {row.participant && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => askReissue(row)} disabled={busy}>
                        코드 재발급
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Dialog
        open={pending !== null}
        title={pending?.title ?? ''}
        confirmLabel={pending?.confirmLabel}
        danger={pending?.danger}
        busy={busy}
        confirmDisabled={pending?.requireText !== undefined && pendingInput.trim() !== pending.requireText}
        onConfirm={confirmPending}
        onClose={() => setPending(null)}
      >
        {pending?.body}
        {pending?.input && (
          <div className="field">
            <label htmlFor="pending-input">{pending.input.label}</label>
            <input id="pending-input" type="text" value={pendingInput} onChange={(e) => setPendingInput(e.target.value)} autoComplete="off" />
          </div>
        )}
      </Dialog>

      <Dialog
        open={issuedInvites !== null}
        title="참여 비밀번호"
        cancelLabel="전달했습니다"
        onClose={() => setIssuedInvites(null)}
      >
        <p>
          <strong>이 창을 닫으면 다시 볼 수 없습니다.</strong> 각자에게 본인의 비밀번호만 직접 전달해 주세요. 잃어버리면 재발급할 수
          있습니다.
        </p>
        <ul className="invite-list">
          {issuedInvites?.map((item) => (
            <li key={item.rosterId}>
              <span className="invite-name">{item.name}</span>
              <code className="invite-code">{formatAccessCode(item.inviteCode)}</code>
            </li>
          ))}
        </ul>
        {issuedInvites && (
          <CopyButton
            text={issuedInvites.map((item) => `${item.name}: ${formatAccessCode(item.inviteCode)}`).join('\n')}
            label={issuedInvites.length > 1 ? '전체 복사' : '복사'}
          />
        )}
      </Dialog>

      <Dialog open={issuedCode !== null} title="새 접속 코드" cancelLabel="전달했습니다" onClose={() => setIssuedCode(null)}>
        <p>
          <strong>{issuedCode?.name}</strong> 님의 새 접속 코드입니다. 이 창을 닫으면 다시 볼 수 없습니다.
        </p>
        <p className="code-box">{issuedCode?.code}</p>
        {issuedCode && <CopyButton text={issuedCode.code} label="접속 코드 복사" />}
      </Dialog>
    </Page>
  );
}

function LoginForm(props: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/admin/login', { password });
      setPassword('');
      await props.onDone();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="관리자 로그인">
      <form className="card" onSubmit={onSubmit}>
        <h1>관리자 로그인</h1>
        <div className="field">
          <label htmlFor={inputId}>관리자 비밀번호</label>
          <input
            id={inputId}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || password === ''}>
            {busy ? '확인 중…' : '로그인'}
          </button>
        </div>
      </form>
    </Page>
  );
}

type Perform = (action: () => Promise<string | void>) => Promise<boolean>;

function SettingsForm(props: { dashboard: AdminDashboard; perform: Perform; busy: boolean }) {
  const { event } = props.dashboard;
  const [name, setName] = useState(event.name);
  const [deadline, setDeadline] = useState(utcToKstInput(event.deadlineAt));
  const [budget, setBudget] = useState(event.budgetNote);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), deadline: useId(), budget: useId() };

  const onSubmit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setError(null);
    const cleanedName = cleanEventName(name);
    if (!cleanedName.ok) return setError(cleanedName.message);
    const cleanedBudget = cleanBudgetNote(budget);
    if (!cleanedBudget.ok) return setError(cleanedBudget.message);
    const deadlineAt = kstInputToUtc(deadline);
    if (!deadlineAt) return setError('마감 일시를 입력해 주세요.');
    await props.perform(async () => {
      await api('PATCH', '/api/admin/settings', { name: cleanedName.value, budgetNote: cleanedBudget.value, deadlineAt });
      return '행사 설정을 저장했습니다.';
    });
  };

  return (
    <form className="card" onSubmit={onSubmit} noValidate>
      <h2>행사 설정{event.status === 'OPEN' ? ' · 마감 연장' : ''}</h2>
      <div className="field">
        <label htmlFor={ids.name}>행사명</label>
        <input id={ids.name} type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.deadline}>목표 작성 마감 (한국 시각)</label>
        <input id={ids.deadline} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        <p className="hint">어느 기기에서 입력하든 한국 시각(KST)으로 저장됩니다.</p>
      </div>
      <div className="field">
        <label htmlFor={ids.budget}>선물 예산 안내</label>
        <input id={ids.budget} type="text" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="예: 2만원 내외" />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={props.busy}>
          설정 저장
        </button>
      </div>
    </form>
  );
}

function RosterAddForm(props: { revision: number; perform: Perform; busy: boolean }) {
  const [single, setSingle] = useState('');
  const [bulk, setBulk] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = { single: useId(), bulk: useId() };

  const add = async (rawNames: string[], clear: () => void) => {
    setError(null);
    const names = rawNames.map((item) => item.trim()).filter((item) => item !== '');
    if (names.length === 0) return setError('이름을 입력해 주세요.');
    for (const item of names) {
      const cleaned = cleanRosterName(item);
      if (!cleaned.ok) return setError(`${item}: ${cleaned.message}`);
    }
    const ok = await props.perform(async () => {
      await api('POST', '/api/admin/roster', { names, expectedRevision: props.revision });
      return `${names.length}명을 명단에 추가했습니다.`;
    });
    if (ok) clear();
  };

  return (
    <section className="card">
      <h2>참석자 추가</h2>
      <p className="hint">
        참석 인원은 활성 명단의 이름 수로 계산됩니다({LIMITS.rosterMin}~{LIMITS.rosterMax}명). 동명이인은 ‘민수 A’, ‘민수 B’처럼
        구분해 주세요.
      </p>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add([single], () => setSingle(''));
        }}
      >
        <div className="field">
          <label htmlFor={ids.single}>한 명 추가</label>
          <input id={ids.single} type="text" value={single} onChange={(e) => setSingle(e.target.value)} autoComplete="off" />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={props.busy}>
          추가
        </button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add(bulk.split(/\r?\n/), () => setBulk(''));
        }}
      >
        <div className="field">
          <label htmlFor={ids.bulk}>여러 명 일괄 추가 (한 줄에 한 명)</label>
          <textarea id={ids.bulk} rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} />
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-secondary" disabled={props.busy}>
            일괄 추가
          </button>
        </div>
      </form>
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
