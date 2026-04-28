#!/bin/bash

# ============================================
# 변경사항 커밋 및 푸시 스크립트
# 사용법:
#   ./scripts/commit-and-push.sh "커밋 메시지"
#   ./scripts/commit-and-push.sh               (기본 메시지 사용)
# ============================================

set -e

# 커밋 메시지 (인자로 전달하거나 기본값 사용)
MESSAGE=${1:-"chore: commit changes"}

# 1) 상태 확인
echo "=== Git Status ==="
git status --short
echo ""

# 변경사항이 없으면 종료
if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to commit."
  exit 0
fi

# 2) 모든 변경 스테이징
git add -A

# 3) 커밋
git commit -m "$MESSAGE"

# 4) 현재 브랜치 확인 및 푸시
BRANCH=$(git branch --show-current)
echo ""
echo "Pushing to origin/$BRANCH..."
git push origin "$BRANCH"

echo ""
echo "Done! Committed and pushed to $BRANCH."
