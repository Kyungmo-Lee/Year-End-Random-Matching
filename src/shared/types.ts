// API 응답 형태. 화면과 서버가 같은 정의를 사용한다.

export type EventStatus = 'SETUP' | 'OPEN' | 'MATCHED' | 'CLOSED' | 'DELETED';
export type SubmitStatus = 'DRAFT' | 'SUBMITTED';

export interface EventInfo {
  status: EventStatus;
  name: string;
  budgetNote: string;
  deadlineAt: string | null;
  revealed: boolean;
  serverTime: string;
}

export interface RosterOption {
  id: number;
  name: string;
  available: boolean;
}

export interface MeResponse {
  event: EventInfo;
  rosterName: string;
  nickname: string;
  goalText: string;
  submitStatus: SubmitStatus;
  assignmentViewed: boolean;
  csrfToken: string;
}

export interface RegisterResponse {
  accessCode: string;
  csrfToken: string;
}

export interface SubmitResponse {
  submitted: true;
  eventStatus: EventStatus;
}

/** 개인 배정 결과. 이 네 필드 외에는 내려주지 않는다. */
export interface AssignmentView {
  receiverNickname: string;
  assignedGoalText: string;
  receiverGiftNumber: number;
  myGiftNumber: number;
}

export interface ResultPair {
  santaNickname: string;
  receiverNickname: string;
}

export interface AdminRosterRow {
  id: number;
  name: string;
  active: boolean;
  /** 참여 비밀번호가 발급되어 아직 사용되지 않았는가. 비밀번호 자체는 조회할 수 없다. */
  inviteIssued: boolean;
  participant: {
    id: number;
    nickname: string;
    submitStatus: SubmitStatus;
    submittedAt: string | null;
    viewed: boolean;
  } | null;
}

export interface AdminDashboard {
  event: EventInfo & {
    revision: number;
    matchedAt: string | null;
    closedAt: string | null;
    revealedAt: string | null;
    deletedAt: string | null;
    deleteDueAt: string | null;
  };
  counts: { active: number; registered: number; submitted: number; viewed: number };
  roster: AdminRosterRow[];
  csrfToken: string;
}

export interface IssuedInvite {
  rosterId: number;
  name: string;
  inviteCode: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
