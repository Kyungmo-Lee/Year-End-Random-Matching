-- 새해 목표 선물 교환: 초기 스키마 (design.md v1.1 §6)
-- 모든 시각은 UTC ISO-8601 문자열(예: 2026-12-20T14:59:00.000Z)이며 같은 형식끼리 문자열 비교한다.

CREATE TABLE event (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  name          TEXT    NOT NULL DEFAULT '',
  budget_note   TEXT    NOT NULL DEFAULT '',
  deadline_at   TEXT,
  status        TEXT    NOT NULL DEFAULT 'SETUP'
                CHECK (status IN ('SETUP', 'OPEN', 'MATCHED', 'CLOSED', 'DELETED')),
  -- 매칭에 영향을 주는 변경(명단·등록·확정)마다 증가한다.
  revision      INTEGER NOT NULL DEFAULT 0,
  -- 현재 유효한 매칭 실행 ID. 번호·배정 행은 이 값과 일치할 때만 유효하다.
  match_run_id  TEXT,
  -- 관리자 다단계 쓰기의 작업 소유권 토큰.
  op_token      TEXT,
  matched_at    TEXT,
  closed_at     TEXT,
  revealed_at   TEXT,
  deleted_at    TEXT,
  updated_at    TEXT    NOT NULL DEFAULT ''
);

INSERT INTO event (id) VALUES (1);

CREATE TABLE roster (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name    TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 30),
  normalized_name TEXT    NOT NULL UNIQUE,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT    NOT NULL
);

CREATE TABLE participants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id           INTEGER NOT NULL UNIQUE REFERENCES roster (id),
  nickname            TEXT    NOT NULL CHECK (length(nickname) BETWEEN 2 AND 20),
  normalized_nickname TEXT    NOT NULL UNIQUE,
  goal_text           TEXT    NOT NULL DEFAULT '' CHECK (length(goal_text) <= 100),
  submit_status       TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (submit_status IN ('DRAFT', 'SUBMITTED')),
  submitted_at        TEXT,
  code_hash           TEXT    NOT NULL UNIQUE,
  credential_version  INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (submit_status = 'DRAFT' OR length(goal_text) >= 1)
);

CREATE TABLE gift_numbers (
  participant_id INTEGER PRIMARY KEY REFERENCES participants (id),
  number         INTEGER NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 99),
  match_run_id   TEXT    NOT NULL
);

CREATE TABLE assignments (
  santa_id     INTEGER PRIMARY KEY REFERENCES participants (id),
  receiver_id  INTEGER NOT NULL UNIQUE REFERENCES participants (id),
  match_run_id TEXT    NOT NULL,
  viewed_at    TEXT,
  CHECK (santa_id != receiver_id)
);

CREATE TABLE sessions (
  token_hash         TEXT PRIMARY KEY,
  role               TEXT NOT NULL CHECK (role IN ('admin', 'participant')),
  participant_id     INTEGER REFERENCES participants (id) ON DELETE CASCADE,
  credential_version INTEGER,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  CHECK ((role = 'admin' AND participant_id IS NULL) OR (role = 'participant' AND participant_id IS NOT NULL))
);

CREATE INDEX idx_sessions_participant ON sessions (participant_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE auth_attempts (
  scope_hash    TEXT PRIMARY KEY,
  window_start  TEXT    NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT
);

-- 항상 비어 있는 테이블. batch 안에서 불변식이 깨졌을 때 `INSERT ... SELECT 0 WHERE <위반>` 으로
-- CHECK 오류를 일으켜 트랜잭션 전체를 롤백시키는 용도다.
CREATE TABLE tx_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
