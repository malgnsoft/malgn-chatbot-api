-- TB_SESSION에 퀴즈 난이도 컬럼 추가
-- 값: 'easy' (쉬움), 'normal' (보통), 'hard' (어려움)
ALTER TABLE TB_SESSION ADD COLUMN quiz_difficulty TEXT DEFAULT 'normal';
