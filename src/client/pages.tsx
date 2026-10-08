import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type {
  AssignmentView,
  EventInfo,
  MeResponse,
  RegisterResponse,
  ResultPair,
  RosterOption,
  SubmitResponse,
} from '../shared/types';
import {
  cleanGoal,
  cleanNickname,
  formatAccessCode,
  formatGiftNumber,
  formatKst,
  LIMITS,
  normalizeAccessCode,
  normalizeInviteCode,
} from '../shared/validation';
import { api, ApiError, errorMessage } from './api';
import {
  CharCount,
  CopyButton,
  Dialog,
  EventSummary,
  ExchangeGuide,
  isDeadlinePassed,
  Loading,
  Notice,
  Page,
  StatusBadge,
} from './components';
import { Link, navigate } from './router';

function DeletedNotice() {
  return (
    <Notice kind="info">
      행사가 끝나 모든 참여 데이터(이름·닉네임·목표·배정)가 삭제되었습니다. 더 이상 조회하거나 참여할 수 없습니다.
    </Notice>
  );
}

function useEvent(): { event: EventInfo | null; error: string | null } {
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<EventInfo>('GET', '/api/event').then(setEvent, (reason) => setError(errorMessage(reason)));
  }, []);
  return { event, error };
}

// ---- / ----------------------------------------------------------------------

export function HomePage() {
  const { event, error } = useEvent();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    api<MeResponse>('GET', '/api/me').then(
      () => setSignedIn(true),
      () => setSignedIn(false),
    );
  }, []);

  if (error) {
    return (
      <Page title="참여 안내">
        <Notice kind="error">{error}</Notice>
      </Page>
    );
  }
  if (!event) {
    return (
      <Page title="참여 안내">
        <Loading />
      </Page>
    );
  }
  const closedForEntry = event.status === 'OPEN' && isDeadlinePassed(event);
  return (
    <Page title="참여 안내">
      <section className="card hero">
        <StatusBadge status={event.status} />
        <h1>{event.name || '새해 목표 선물 교환'}</h1>
        {event.status === 'DELETED' ? (
          <DeletedNotice />
        ) : (
          <>
            <p className="lead">
              새해 목표를 적어 내면 무작위로 한 사람에게 전달됩니다. 배정받은 분의 목표를 응원하는 선물을 준비해 주세요.
            </p>
            {event.status !== 'SETUP' && <EventSummary event={event} />}
          </>
        )}

        {event.status === 'SETUP' && <Notice kind="info">아직 준비 중입니다. 주최자가 참여를 시작하면 등록할 수 있습니다.</Notice>}
        {closedForEntry && <Notice kind="warn">목표 작성이 마감되었습니다. 이미 등록했다면 접속 코드로 들어가 상태를 확인해 주세요.</Notice>}

        {event.status !== 'SETUP' && event.status !== 'DELETED' && (
          <div className="actions">
            {signedIn ? (
              <Link to="/me" className="btn btn-primary">
                내 페이지로 이동
              </Link>
            ) : (
              <>
                {event.status === 'OPEN' && !closedForEntry && (
                  <Link to="/join" className="btn btn-primary">
                    참여하기
                  </Link>
                )}
                <Link to="/access" className={event.status === 'OPEN' && !closedForEntry ? 'btn btn-secondary' : 'btn btn-primary'}>
                  접속 코드로 재접속
                </Link>
              </>
            )}
            {event.revealed && signedIn && (
              <Link to="/results" className="btn btn-secondary">
                전체 결과 보기
              </Link>
            )}
          </div>
        )}
      </section>
      {event.status !== 'DELETED' && <ExchangeGuide budgetNote={event.budgetNote} />}
    </Page>
  );
}

// ---- /join ------------------------------------------------------------------

export function JoinPage() {
  const { event, error: eventError } = useEvent();
  const [roster, setRoster] = useState<RosterOption[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterId, setRosterId] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessCode, setAccessCode] = useState<string | null>(null);
  const ids = { name: useId(), invite: useId(), inviteHint: useId(), nickname: useId(), goal: useId(), nicknameHint: useId(), goalHint: useId() };

  const loadRoster = useCallback(() => {
    api<{ roster: RosterOption[] }>('GET', '/api/roster').then(
      (data) => setRoster(data.roster),
      (reason) => setRosterError(errorMessage(reason)),
    );
  }, []);
  useEffect(loadRoster, [loadRoster]);

  const onSubmit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setError(null);
    if (!rosterId) return setError('명단에서 본인 이름을 선택해 주세요.');
    const invite = normalizeInviteCode(inviteCode);
    if (invite === null) return setError('주최자에게 받은 참여 비밀번호 8자리를 확인해 주세요.');
    const cleanedNickname = cleanNickname(nickname);
    if (!cleanedNickname.ok) return setError(cleanedNickname.message);
    const cleanedGoal = cleanGoal(goal, { allowEmpty: true });
    if (!cleanedGoal.ok) return setError(cleanedGoal.message);
    setBusy(true);
    try {
      const result = await api<RegisterResponse>('POST', '/api/participants', {
        rosterId: Number(rosterId),
        inviteCode: invite,
        nickname: cleanedNickname.value.nickname,
        goalText: cleanedGoal.value,
      });
      setAccessCode(result.accessCode);
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && (reason.code === 'NAME_TAKEN' || reason.code === 'NAME_UNAVAILABLE')) loadRoster();
    } finally {
      setBusy(false);
    }
  };

  if (accessCode) {
    const formatted = formatAccessCode(accessCode);
    return (
      <Page title="접속 코드">
        <section className="card">
          <h1>등록되었습니다</h1>
          <Notice kind="warn">
            아래 <strong>접속 코드</strong>는 지금 한 번만 표시됩니다. 다른 기기나 나중에 다시 들어올 때 필요하니 꼭 복사해 보관해
            주세요. 잃어버리면 주최자에게 재발급을 요청해야 합니다.
          </Notice>
          <p className="code-box" aria-label="접속 코드">
            {formatted}
          </p>
          <div className="actions">
            <CopyButton text={formatted} label="접속 코드 복사" />
            <button type="button" className="btn btn-primary" onClick={() => navigate('/me')}>
              보관했습니다 — 내 페이지로
            </button>
          </div>
          <p className="hint">아직 확정 제출 전입니다. 내 페이지에서 닉네임과 목표를 다듬은 뒤 마감 전에 확정해 주세요.</p>
        </section>
      </Page>
    );
  }

  const loadError = eventError ?? rosterError;
  if (event?.status === 'DELETED') {
    return (
      <Page title="참여 등록">
        <DeletedNotice />
      </Page>
    );
  }
  if (event && (event.status !== 'OPEN' || isDeadlinePassed(event))) {
    return (
      <Page title="참여 등록">
        <section className="card">
          <h1>참여 등록</h1>
          <Notice kind="warn">
            {event.status === 'SETUP'
              ? '아직 참여가 시작되지 않았습니다.'
              : event.status === 'OPEN'
                ? '목표 작성이 마감되어 새로 등록할 수 없습니다.'
                : '등록 기간이 끝났습니다.'}
          </Notice>
          <div className="actions">
            <Link to="/access" className="btn btn-primary">
              접속 코드로 재접속
            </Link>
            <Link to="/" className="btn btn-ghost">
              처음으로
            </Link>
          </div>
        </section>
      </Page>
    );
  }
  if (loadError) {
    return (
      <Page title="참여 등록">
        <Notice kind="error">{loadError}</Notice>
      </Page>
    );
  }
  if (!event || !roster) {
    return (
      <Page title="참여 등록">
        <Loading />
      </Page>
    );
  }

  const available = roster.filter((option) => option.available);
  return (
    <Page title="참여 등록">
      <form className="card" onSubmit={onSubmit} noValidate>
        <h1>참여 등록</h1>
        <EventSummary event={event} />
        {roster.length === 0 ? (
          <Notice kind="info">명단이 비어 있습니다. 주최자에게 문의해 주세요.</Notice>
        ) : available.length === 0 ? (
          <Notice kind="info">명단의 모든 분이 이미 등록했습니다. 등록했다면 접속 코드로 재접속해 주세요.</Notice>
        ) : null}

        <div className="field">
          <label htmlFor={ids.name}>명단에서 본인 이름 선택</label>
          <select id={ids.name} value={rosterId} onChange={(e) => setRosterId(e.target.value)} required>
            <option value="">선택해 주세요</option>
            {roster.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.name}
                {option.available ? '' : ' (등록 완료)'}
              </option>
            ))}
          </select>
          <p className="hint">이름은 참여 자격 확인에만 쓰이며, 다른 참여자에게는 닉네임만 보입니다.</p>
        </div>

        <div className="field">
          <label htmlFor={ids.invite}>참여 비밀번호</label>
          <input
            id={ids.invite}
            className="code-input"
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={ids.inviteHint}
            required
          />
          <p className="hint" id={ids.inviteHint}>
            주최자가 본인에게 직접 전달한 8자리입니다. 선택한 이름의 비밀번호와 일치해야 등록됩니다. 받지 못했다면 주최자에게 요청해
            주세요.
          </p>
        </div>

        <div className="field">
          <label htmlFor={ids.nickname}>닉네임</label>
          <input
            id={ids.nickname}
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            autoComplete="off"
            aria-describedby={ids.nicknameHint}
            required
          />
          <p className="hint" id={ids.nicknameHint}>
            {LIMITS.nicknameMin}~{LIMITS.nicknameMax}자. 배정 상대와 공개 결과에 이 닉네임이 표시됩니다.{' '}
            <CharCount value={nickname} max={LIMITS.nicknameMax} />
          </p>
        </div>

        <div className="field">
          <label htmlFor={ids.goal}>새해 목표 (지금은 비워 두어도 됩니다)</label>
          <textarea id={ids.goal} rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} aria-describedby={ids.goalHint} />
          <p className="hint" id={ids.goalHint}>
            {LIMITS.goalMax}자 이내. 등록 후 내 페이지에서 수정하고 확정 제출합니다. <CharCount value={goal} max={LIMITS.goalMax} />
          </p>
        </div>

        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || available.length === 0}>
            {busy ? '등록 중…' : '임시저장하고 접속 코드 받기'}
          </button>
          <Link to="/access" className="btn btn-ghost">
            이미 등록했어요
          </Link>
        </div>
      </form>
    </Page>
  );
}

// ---- /access ----------------------------------------------------------------

export function AccessPage() {
  const { event } = useEvent();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const onSubmit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setError(null);
    if (normalizeAccessCode(code) === null) return setError('접속 코드 16자리를 확인해 주세요.');
    setBusy(true);
    try {
      await api('POST', '/api/access', { code });
      navigate('/me');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  if (event?.status === 'DELETED') {
    return (
      <Page title="재접속">
        <DeletedNotice />
      </Page>
    );
  }
  return (
    <Page title="재접속">
      <form className="card" onSubmit={onSubmit} noValidate>
        <h1>접속 코드로 재접속</h1>
        <div className="field">
          <label htmlFor={inputId}>접속 코드</label>
          <input
            id={inputId}
            className="code-input"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
          />
          <p className="hint">등록할 때 받은 16자리 코드입니다. 잃어버렸다면 주최자에게 재발급을 요청해 주세요.</p>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '확인 중…' : '접속하기'}
          </button>
          <Link to="/" className="btn btn-ghost">
            처음으로
          </Link>
        </div>
      </form>
    </Page>
  );
}

// ---- /me --------------------------------------------------------------------

export function MePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api<MeResponse>('GET', '/api/me'));
      setLoadError(null);
    } catch (reason) {
      setLoadError(reason instanceof ApiError ? reason : new ApiError(0, 'UNKNOWN', errorMessage(reason)));
    }
  }, []);
  useEffect(() => void load(), [load]);

  // 제출 후 매칭 대기 중에는 주기적으로 상태를 확인한다.
  const waiting = me?.event.status === 'OPEN' && me.submitStatus === 'SUBMITTED';
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const logout = async () => {
    try {
      await api('POST', '/api/logout', { role: 'participant' });
    } finally {
      navigate('/');
    }
  };

  if (loadError && !me) {
    return (
      <Page title="내 페이지">
        {loadError.code === 'EVENT_DELETED' ? (
          <DeletedNotice />
        ) : loadError.status === 401 ? (
          <section className="card">
            <h1>내 페이지</h1>
            <Notice kind="info">접속 코드로 접속한 뒤 볼 수 있습니다. 코드가 재발급되었다면 새 코드를 사용해 주세요.</Notice>
            <div className="actions">
              <Link to="/access" className="btn btn-primary">
                접속 코드 입력
              </Link>
              <Link to="/" className="btn btn-ghost">
                처음으로
              </Link>
            </div>
          </section>
        ) : (
          <Notice kind="error">{loadError.message}</Notice>
        )}
      </Page>
    );
  }
  if (!me) {
    return (
      <Page title="내 페이지">
        <Loading />
      </Page>
    );
  }

  const { event } = me;
  return (
    <Page title="내 페이지">
      <section className="card">
        <div className="card-head">
          <StatusBadge status={event.status} />
          <button type="button" className="btn btn-ghost btn-small" onClick={logout}>
            이 기기에서 나가기
          </button>
        </div>
        <h1>{event.name}</h1>
        <p className="hint">명단 이름: {me.rosterName} (다른 참여자에게는 표시되지 않습니다)</p>
        <EventSummary event={event} />
      </section>

      {event.status === 'OPEN' && me.submitStatus === 'DRAFT' && <DraftEditor me={me} onChanged={load} />}
      {event.status === 'OPEN' && me.submitStatus === 'SUBMITTED' && (
        <section className="card">
          <h2>제출 완료 — 매칭 대기 중</h2>
          <Locked me={me} />
          <Notice kind="info">
            명단의 모든 분이 확정하면 자동으로 매칭됩니다. 이 화면은 자동으로 갱신됩니다. 수정이 필요하면 주최자에게 확정 해제를
            요청해 주세요.
          </Notice>
        </section>
      )}
      {(event.status === 'MATCHED' || event.status === 'CLOSED') && <AssignmentSection me={me} onViewed={load} />}

      <ExchangeGuide budgetNote={event.budgetNote} />
    </Page>
  );
}

function Locked(props: { me: MeResponse }) {
  return (
    <dl className="summary">
      <div>
        <dt>내 닉네임</dt>
        <dd>{props.me.nickname}</dd>
      </div>
      <div>
        <dt>내 새해 목표</dt>
        <dd className="goal-text">{props.me.goalText}</dd>
      </div>
    </dl>
  );
}

function DraftEditor(props: { me: MeResponse; onChanged: () => Promise<void> }) {
  const { me } = props;
  const [nickname, setNickname] = useState(me.nickname);
  const [goal, setGoal] = useState(me.goalText);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ nickname: string; goal: string } | null>(null);
  const ids = { nickname: useId(), goal: useId() };
  const deadlinePassed = isDeadlinePassed(me.event);

  /** 바뀐 항목만 저장한다. 성공하면 저장된 값을 돌려준다. */
  const save = async (requireGoal: boolean): Promise<{ nickname: string; goal: string } | null> => {
    setMessage(null);
    const cleanedNickname = cleanNickname(nickname);
    if (!cleanedNickname.ok) {
      setMessage({ kind: 'error', text: cleanedNickname.message });
      return null;
    }
    const cleanedGoal = cleanGoal(goal, { allowEmpty: !requireGoal });
    if (!cleanedGoal.ok) {
      setMessage({ kind: 'error', text: cleanedGoal.message });
      return null;
    }
    setBusy(true);
    try {
      if (cleanedNickname.value.nickname !== me.nickname) {
        await api('PATCH', '/api/me/nickname', { nickname: cleanedNickname.value.nickname });
      }
      if (cleanedGoal.value !== me.goalText) await api('PATCH', '/api/me/goal', { goalText: cleanedGoal.value });
      setNickname(cleanedNickname.value.nickname);
      setGoal(cleanedGoal.value);
      await props.onChanged();
      return { nickname: cleanedNickname.value.nickname, goal: cleanedGoal.value };
    } catch (reason) {
      setMessage({ kind: 'error', text: errorMessage(reason) });
      await props.onChanged();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onSaveDraft = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (await save(false)) setMessage({ kind: 'success', text: '임시저장했습니다. 아직 확정 제출 전입니다.' });
  };

  const onAskSubmit = async () => {
    const saved = await save(true);
    if (saved) setConfirm(saved);
  };

  const onConfirmSubmit = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api<SubmitResponse>('POST', '/api/me/submit', { nickname: confirm.nickname, goalText: confirm.goal });
      setConfirm(null);
      await props.onChanged();
    } catch (reason) {
      setConfirm(null);
      setMessage({ kind: 'error', text: errorMessage(reason) });
      await props.onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (deadlinePassed) {
    return (
      <section className="card">
        <h2>마감되었습니다</h2>
        <Locked me={me} />
        <Notice kind="warn">
          확정 제출 전에 마감되어 지금은 수정·제출할 수 없습니다. 참여를 원하면 주최자에게 마감 연장을 요청해 주세요.
        </Notice>
      </section>
    );
  }

  // 확인 창은 자체 form 을 가지므로 편집 form 밖에 둔다(form 중첩 금지).
  return (
    <>
    <form className="card" onSubmit={onSaveDraft} noValidate>
      <h2>닉네임과 새해 목표</h2>
      <p className="hint">마감({formatKst(me.event.deadlineAt)}) 전까지 수정할 수 있습니다. 확정 제출해야 매칭에 포함됩니다.</p>
      <div className="field">
        <label htmlFor={ids.nickname}>닉네임</label>
        <input id={ids.nickname} type="text" value={nickname} onChange={(e) => setNickname(e.target.value)} autoComplete="off" />
        <p className="hint">
          {LIMITS.nicknameMin}~{LIMITS.nicknameMax}자 <CharCount value={nickname} max={LIMITS.nicknameMax} />
        </p>
      </div>
      <div className="field">
        <label htmlFor={ids.goal}>새해 목표</label>
        <textarea id={ids.goal} rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <p className="hint">
          {LIMITS.goalMax}자 이내 <CharCount value={goal} max={LIMITS.goalMax} />
        </p>
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAskSubmit} disabled={busy}>
          확정 제출
        </button>
        <button type="submit" className="btn btn-secondary" disabled={busy}>
          {busy ? '저장 중…' : '임시저장'}
        </button>
      </div>
    </form>

      <Dialog
        open={confirm !== null}
        title="이대로 확정 제출할까요?"
        confirmLabel="확정 제출"
        busy={busy}
        onConfirm={onConfirmSubmit}
        onClose={() => setConfirm(null)}
      >
        <p>
          확정하면 <strong>닉네임과 목표가 잠겨 직접 수정할 수 없습니다.</strong> 매칭 전에 바꿔야 하면 주최자에게 확정 해제를
          요청해야 합니다.
        </p>
        <dl className="summary">
          <div>
            <dt>닉네임</dt>
            <dd>{confirm?.nickname}</dd>
          </div>
          <div>
            <dt>새해 목표</dt>
            <dd className="goal-text">{confirm?.goal}</dd>
          </div>
        </dl>
      </Dialog>
    </>
  );
}

function AssignmentSection(props: { me: MeResponse; onViewed: () => Promise<void> }) {
  const { me } = props;
  const [assignment, setAssignment] = useState<AssignmentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setAssignment(await api<AssignmentView>('POST', '/api/me/assignment/view'));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  // 이미 열람한 적이 있으면 다시 누르지 않아도 보여준다.
  useEffect(() => {
    if (me.assignmentViewed) void reveal();
  }, [me.assignmentViewed, reveal]);

  return (
    <section className="card" aria-live="polite">
      <h2>배정 결과</h2>
      <Locked me={me} />
      {error && <Notice kind="error">{error}</Notice>}
      {!assignment ? (
        <>
          <p>매칭이 완료되었습니다. 아래 버튼을 누르면 내가 선물할 분의 닉네임·새해 목표와 선물 번호를 확인합니다.</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                await reveal();
                await props.onViewed();
              }}
            >
              {busy ? '확인 중…' : '배정 확인'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="assignment assignment-give">
            <h3>내가 선물할 분</h3>
            <p className="assignment-nickname">{assignment.receiverNickname}</p>
            <p className="assignment-label">이분의 새해 목표</p>
            <p className="goal-text goal-quote">{assignment.assignedGoalText}</p>
            <div className="number-row">
              <span className="number-label">
                받는 분의 선물 번호
                <small>내가 준비한 선물에 적을 번호</small>
              </span>
              <span className="number">{formatGiftNumber(assignment.receiverGiftNumber)}</span>
            </div>
          </div>
          <div className="assignment assignment-mine">
            <h3>내가 받을 선물</h3>
            <div className="number-row">
              <span className="number-label">
                내 선물 번호
                <small>행사 날 이 번호가 적힌 선물을 찾아가세요</small>
              </span>
              <span className="number">{formatGiftNumber(assignment.myGiftNumber)}</span>
            </div>
            <p className="hint">내 산타가 누구인지는 주최자가 결과를 공개한 뒤에 볼 수 있습니다.</p>
          </div>
        </>
      )}
      {me.event.revealed && (
        <div className="actions">
          <Link to="/results" className="btn btn-secondary">
            전체 결과 보기
          </Link>
        </div>
      )}
    </section>
  );
}

// ---- /results ---------------------------------------------------------------

export function ResultsPage() {
  const [data, setData] = useState<{ eventName: string; pairs: ResultPair[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    api<{ eventName: string; pairs: ResultPair[] }>('GET', '/api/results').then(setData, (reason) =>
      setError(reason instanceof ApiError ? reason : new ApiError(0, 'UNKNOWN', errorMessage(reason))),
    );
  }, []);

  return (
    <Page title="전체 결과">
      <section className="card">
        <h1>전체 결과{data ? ` — ${data.eventName}` : ''}</h1>
        {error?.code === 'EVENT_DELETED' ? (
          <DeletedNotice />
        ) : error?.status === 401 ? (
          <>
            <Notice kind="info">참여자 접속 코드 또는 관리자 로그인 후 볼 수 있습니다.</Notice>
            <div className="actions">
              <Link to="/access" className="btn btn-primary">
                접속 코드 입력
              </Link>
            </div>
          </>
        ) : error ? (
          <Notice kind={error.code === 'NOT_REVEALED' ? 'info' : 'error'}>{error.message}</Notice>
        ) : !data ? (
          <Loading />
        ) : data.pairs.length === 0 ? (
          <Notice kind="info">표시할 결과가 없습니다.</Notice>
        ) : (
          <>
            <p className="hint">산타 닉네임 → 받는 사람 닉네임. 목표 내용과 실제 이름은 공개되지 않습니다.</p>
            <table className="results">
              <thead>
                <tr>
                  <th scope="col">산타</th>
                  <th scope="col" aria-label="에게"></th>
                  <th scope="col">받는 사람</th>
                </tr>
              </thead>
              <tbody>
                {data.pairs.map((pair) => (
                  <tr key={pair.santaNickname}>
                    <td>{pair.santaNickname}</td>
                    <td aria-hidden="true">→</td>
                    <td>{pair.receiverNickname}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="actions">
          <Link to="/" className="btn btn-ghost">
            처음으로
          </Link>
        </div>
      </section>
    </Page>
  );
}

export function NotFoundPage() {
  return (
    <Page title="페이지 없음">
      <section className="card">
        <h1>페이지를 찾을 수 없습니다</h1>
        <div className="actions">
          <Link to="/" className="btn btn-primary">
            처음으로
          </Link>
        </div>
      </section>
    </Page>
  );
}
