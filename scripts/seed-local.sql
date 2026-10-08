-- 로컬 테스트 명단. SETUP 상태의 빈 로컬 DB 에만 사용한다: npm run db:seed:local
-- 행사명·마감·예산은 /admin 화면에서 설정한다.
INSERT OR IGNORE INTO roster (display_name, normalized_name, active, created_at)
SELECT value, lower(replace(value, ' ', '')), 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM json_each('["테스트 가람","테스트 나래","테스트 다온","테스트 라온","테스트 마루","테스트 바다"]')
 WHERE EXISTS (SELECT 1 FROM event WHERE id = 1 AND status = 'SETUP');
