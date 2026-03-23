-- TB_QUIZ에 session_id 추가 (세션 직접 추가 퀴즈 지원)
-- content_id는 기존 NOT NULL이지만, 세션 퀴즈는 content_id 없이 생성 가능
-- SQLite는 ALTER COLUMN을 지원하지 않으므로 기본값 0으로 대체

ALTER TABLE TB_QUIZ ADD COLUMN session_id INTEGER;

-- 세션별 퀴즈 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_quiz_session ON TB_QUIZ(session_id, position);
