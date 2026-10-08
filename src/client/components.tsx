import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { EventInfo, EventStatus } from '../shared/types';
import { charLength, formatKst } from '../shared/validation';
import { Link } from './router';

export function Page(props: { title: string; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    document.title = `${props.title} · 새해 목표 선물 교환`;
  }, [props.title]);
  return (
    <div className={props.wide ? 'page page-wide' : 'page'}>
      <header className="site-header">
        <Link to="/" className="brand">
          <span aria-hidden="true">🎁</span> 새해 목표 선물 교환
        </Link>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

export function Loading(props: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {props.label ?? '불러오는 중…'}
    </p>
  );
}

/** 오류는 즉시(alert), 저장 완료 등은 차분하게(status) 읽어준다. */
export function Notice(props: { kind: 'error' | 'success' | 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={`notice notice-${props.kind}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      {props.children}
    </div>
  );
}

const STATUS_LABEL: Record<EventStatus, string> = {
  SETUP: '준비 중',
  OPEN: '참여 진행 중',
  MATCHED: '매칭 완료',
  CLOSED: '행사 종료',
  DELETED: '데이터 삭제됨',
};

export function StatusBadge(props: { status: EventStatus }) {
  return <span className={`badge badge-${props.status.toLowerCase()}`}>{STATUS_LABEL[props.status]}</span>;
}

export function EventSummary(props: { event: EventInfo }) {
  const { event } = props;
  return (
    <dl className="summary">
      <div>
        <dt>목표 작성 마감</dt>
        <dd>{event.deadlineAt ? `${formatKst(event.deadlineAt)} (한국 시각)` : '미정'}</dd>
      </div>
      <div>
        <dt>선물 예산</dt>
        <dd>{event.budgetNote || '안내 없음'}</dd>
      </div>
    </dl>
  );
}

export function isDeadlinePassed(event: EventInfo): boolean {
  return !event.deadlineAt || Date.parse(event.deadlineAt) <= Date.parse(event.serverTime);
}

export function Dialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!props.busy) props.onClose();
      }}
    >
      {props.open && (
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy && !props.confirmDisabled) props.onConfirm?.();
          }}
        >
          <h2 id={titleId}>{props.title}</h2>
          <div className="dialog-body">{props.children}</div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose} disabled={props.busy}>
              {props.cancelLabel ?? (props.onConfirm ? '취소' : '닫기')}
            </button>
            {props.onConfirm && (
              <button
                type="submit"
                className={props.danger ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={props.busy || props.confirmDisabled}
              >
                {props.busy ? '처리 중…' : (props.confirmLabel ?? '확인')}
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}

export function CopyButton(props: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button type="button" className="btn btn-secondary" onClick={copy}>
      <span aria-live="polite">
        {state === 'copied' ? '복사했습니다 ✓' : state === 'failed' ? '복사 실패 — 직접 선택해 복사해 주세요' : props.label}
      </span>
    </button>
  );
}

export function CharCount(props: { value: string; max: number; id?: string }) {
  const length = charLength(props.value.replace(/\r\n?/g, '\n').normalize('NFC').trim());
  return (
    <span id={props.id} className={length > props.max ? 'char-count over' : 'char-count'}>
      {length}/{props.max}자
    </span>
  );
}

export function ExchangeGuide(props: { budgetNote: string }) {
  return (
    <section className="guide" aria-labelledby="guide-title">
      <h2 id="guide-title">선물 교환 방법</h2>
      <ol>
        <li>
          주최자에게 받은 <strong>참여 비밀번호</strong>로 등록하고, 닉네임과 새해 목표를 적어 마감 전에 확정 제출합니다.
        </li>
        <li>
          매칭이 끝나면 <strong>배정 확인</strong>에서 내가 선물할 분의 <strong>닉네임과 새해 목표</strong>를 봅니다.
        </li>
        <li>
          그 목표를 응원하는 선물을 준비합니다.
          {props.budgetNote ? (
            <>
              {' '}
              예산: <strong>{props.budgetNote}</strong>
            </>
          ) : null}
        </li>
        <li>
          선물이나 카드 겉면에 <strong>받는 분의 선물 번호</strong>를 크게 적습니다. 닉네임을 함께 적어도 됩니다. 내 이름은 적지
          않습니다.
        </li>
        <li>
          행사 당일 선물을 모아 두고, 각자 <strong>내 선물 번호</strong>가 적힌 선물을 찾아갑니다.
        </li>
        <li>누가 내 산타였는지는 행사 종료 후 주최자가 결과를 공개하면 닉네임으로 확인할 수 있습니다.</li>
      </ol>
      <p className="hint">닉네임으로 서로를 알아볼 수 있으므로 완전한 익명이 보장되지는 않습니다.</p>
    </section>
  );
}
