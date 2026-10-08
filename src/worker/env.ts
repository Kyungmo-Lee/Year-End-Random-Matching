export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC 키. IP 해시와 CSRF 토큰 파생에 사용한다. Worker secret. */
  SESSION_SECRET: string;
  /** `pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>` 형식의 관리자 비밀번호 검증 값. Worker secret. */
  ADMIN_PASSWORD_HASH: string;
}
