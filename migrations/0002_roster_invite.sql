-- 참여 비밀번호: 관리자가 명단의 사람마다 발급해 직접 전달하고, 참여 등록 때 입력받아 확인한다.
-- 원문은 저장하지 않고 서버 secret 기반 HMAC 만 저장한다. 등록에 사용되면 NULL 로 지운다.
ALTER TABLE roster ADD COLUMN invite_hash TEXT;
