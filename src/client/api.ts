import type { ApiErrorBody } from '../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Role = 'admin' | 'participant';

// CSRF 토큰은 메모리에만 둔다. 새로 고침하면 /api/me·대시보드 응답으로 다시 받는다.
const csrfTokens: Partial<Record<Role, string>> = {};

function roleOf(path: string): Role {
  return path.startsWith('/api/admin') ? 'admin' : 'participant';
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  role: Role = roleOf(path),
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    const token = csrfTokens[role];
    if (token) headers['X-CSRF-Token'] = token;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // 본문이 JSON 이 아니면 아래에서 일반 오류로 처리한다.
  }
  if (!response.ok) {
    const error = (parsed as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'UNKNOWN', error?.message ?? '요청을 처리하지 못했습니다.');
  }
  const token = (parsed as { csrfToken?: unknown } | null)?.csrfToken;
  if (typeof token === 'string') csrfTokens[role] = token;
  return parsed as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '알 수 없는 오류가 발생했습니다.';
}
