#!/bin/bash

# ============================================
# 테넌트 배포 스크립트
# 사용법:
#   ./scripts/deploy.sh <tenant_id>  - 특정 테넌트 배포
#   ./scripts/deploy.sh --all        - 전체 테넌트 배포
# ============================================

set -e

# wrangler.toml에서 테넌트 목록 추출
get_tenants() {
  grep -oE '^\[env\.([a-zA-Z0-9_-]+)\]' wrangler.toml | sed 's/\[env\.\(.*\)\]/\1/' | sort -u
}

deploy_tenant() {
  local tenant=$1
  echo "============================================"
  echo "Deploying: $tenant"
  echo "============================================"
  wrangler deploy --env "$tenant"
  echo ""
}

if [ "$1" == "--all" ]; then
  echo "Deploying all tenants..."
  echo ""

  TENANTS=$(get_tenants)

  if [ -z "$TENANTS" ]; then
    echo "No tenants found in wrangler.toml"
    exit 1
  fi

  for tenant in $TENANTS; do
    deploy_tenant "$tenant"
  done

  echo "============================================"
  echo "All tenants deployed successfully!"
  echo "============================================"

elif [ -n "$1" ]; then
  deploy_tenant "$1"
  echo "Deployed successfully!"

else
  echo "Usage:"
  echo "  ./scripts/deploy.sh <tenant_id>  - Deploy specific tenant"
  echo "  ./scripts/deploy.sh --all        - Deploy all tenants"
  echo ""
  echo "Available tenants:"
  get_tenants | sed 's/^/  - /'
fi
