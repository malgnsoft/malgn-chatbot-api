-- 005: TB_SESSION quiz_count → choice_count + ox_count 분리
-- 4지선다와 OX 퀴즈 수를 각각 설정할 수 있도록 컬럼 분리

ALTER TABLE TB_SESSION ADD COLUMN choice_count INTEGER DEFAULT 3;
ALTER TABLE TB_SESSION ADD COLUMN ox_count INTEGER DEFAULT 2;
