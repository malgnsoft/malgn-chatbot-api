-- 004: TB_CONTENT에 lesson_id 추가 (LMS 차시별 콘텐츠 분류)
-- 실행: wrangler d1 execute malgn-chatbot-db --file=./migrations/004_content_lesson_id.sql
-- user2: wrangler d1 execute malgn-chatbot-db-user2 --file=./migrations/004_content_lesson_id.sql --env user2

ALTER TABLE TB_CONTENT ADD COLUMN lesson_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_content_lesson_id ON TB_CONTENT(lesson_id);
