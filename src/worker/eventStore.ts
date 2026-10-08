import type { EventInfo, EventStatus } from '../shared/types';
import { nowIso } from './http';

export interface EventRow {
  status: EventStatus;
  name: string;
  budget_note: string;
  deadline_at: string | null;
  revision: number;
  matched_at: string | null;
  closed_at: string | null;
  revealed_at: string | null;
  deleted_at: string | null;
}

export const EVENT_COLUMNS =
  'status, name, budget_note, deadline_at, revision, matched_at, closed_at, revealed_at, deleted_at';

export function selectEvent(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT ${EVENT_COLUMNS} FROM event WHERE id = 1`);
}

export async function loadEvent(db: D1Database): Promise<EventRow> {
  return (await selectEvent(db).first<EventRow>())!;
}

export function toEventInfo(row: EventRow): EventInfo {
  return {
    status: row.status,
    name: row.name,
    budgetNote: row.budget_note,
    deadlineAt: row.deadline_at,
    revealed: row.revealed_at !== null,
    serverTime: nowIso(),
  };
}

export function isPastDeadline(row: Pick<EventRow, 'deadline_at'>, now: string): boolean {
  return !row.deadline_at || row.deadline_at <= now;
}
