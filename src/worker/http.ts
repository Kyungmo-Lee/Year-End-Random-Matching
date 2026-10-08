export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, init: { status?: number; cookies?: string[] } = {}): Response {
  const headers = new Headers(BASE_HEADERS);
  for (const cookie of init.cookies ?? []) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function errorResponse(error: HttpError): Response {
  const headers = new Headers({ ...BASE_HEADERS, ...error.headers });
  return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
    status: error.status,
    headers,
  });
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 형식으로 요청해 주세요.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청이 너무 큽니다.');
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '요청 형식이 올바르지 않습니다.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_JSON', '요청 형식이 올바르지 않습니다.');
  }
  return parsed as Record<string, unknown>;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** 세션 쿠키. 로컬 http 개발 주소에서만 Secure 를 생략한다. */
export function sessionCookie(url: URL, name: string, value: string, maxAgeSeconds: number): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (!isLocalHttp(url)) parts.push('Secure');
  return parts.join('; ');
}

export function isUniqueViolation(error: unknown, column?: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('UNIQUE constraint failed')) return false;
  return column ? message.includes(column) : true;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parsePositiveInt(raw: unknown): number | null {
  const value = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
