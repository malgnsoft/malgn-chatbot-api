-- 010: TB_AI_LOG content_id → lesson_id 변경
ALTER TABLE TB_AI_LOG RENAME COLUMN content_id TO lesson_id;
CREATE INDEX IF NOT EXISTS idx_ai_log_lesson_id ON TB_AI_LOG(lesson_id);
