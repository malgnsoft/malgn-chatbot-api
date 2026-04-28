-- TB_SESSION에 생성 상태 컬럼 추가
-- none       : 동기 생성 (기존 세션 호환)
-- pending    : 큐 대기 중
-- processing : 생성 중
-- completed  : 완료
-- failed     : 실패
ALTER TABLE TB_SESSION ADD COLUMN generation_status TEXT DEFAULT 'none';
