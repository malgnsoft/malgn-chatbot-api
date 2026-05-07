#!/bin/bash

# ============================================
# 새 테넌트 생성 스크립트 (MySQL/Hyperdrive 표준)
#
# 사용법:
#   ./scripts/create-tenant.sh <tenant_id> "<mysql_connection_string>"
#
# 예시:
#   ./scripts/create-tenant.sh acme \
#     "mysql://admin:password@db.example.com:3306/aitutor_acme"
#
# 사전 준비:
#   - MySQL 8.0+ 인스턴스가 외부에서 접근 가능해야 함
#   - 인스턴스에 빈 데이터베이스(스키마)가 미리 만들어져 있어야 함
# ============================================

set -e

TENANT_ID=$1
MYSQL_URL=$2

if [ -z "$TENANT_ID" ] || [ -z "$MYSQL_URL" ]; then
  echo "Usage: ./scripts/create-tenant.sh <tenant_id> \"<mysql_connection_string>\""
  echo ""
  echo "Example:"
  echo "  ./scripts/create-tenant.sh acme \\"
  echo "    \"mysql://admin:password@db.example.com:3306/aitutor_acme\""
  exit 1
fi

echo "============================================"
echo "Creating tenant: $TENANT_ID"
echo "Worker name:     malgn-chatbot-api-${TENANT_ID}"
echo "============================================"
echo ""

# 1. Hyperdrive 생성 (MySQL 연결)
echo "[1/4] Creating Hyperdrive (MySQL connection)..."
HD_OUTPUT=$(wrangler hyperdrive create "malgn-chatbot-hyperdrive-${TENANT_ID}" \
  --connection-string="${MYSQL_URL}" 2>&1)
HD_ID=$(echo "$HD_OUTPUT" | grep -oE 'id = "[^"]+"' | head -1 | cut -d'"' -f2)
if [ -z "$HD_ID" ]; then
  echo "  ✗ Hyperdrive 생성 실패. 출력:"
  echo "$HD_OUTPUT"
  exit 1
fi
echo "  Hyperdrive ID: $HD_ID"
echo ""

# 2. KV Namespace 생성
echo "[2/4] Creating KV Namespace..."
KV_OUTPUT=$(wrangler kv namespace create "malgn-chatbot-kv-${TENANT_ID}" 2>&1)
KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id = "[^"]+"' | head -1 | cut -d'"' -f2)
if [ -z "$KV_ID" ]; then
  echo "  ✗ KV 생성 실패. 출력:"
  echo "$KV_OUTPUT"
  exit 1
fi
echo "  KV Namespace ID: $KV_ID"
echo ""

# 3. R2 Bucket 생성
echo "[3/4] Creating R2 Bucket..."
wrangler r2 bucket create "malgn-chatbot-files-${TENANT_ID}"
echo ""

# 4. Vectorize Index 생성 (bge-m3: 1024차원, 코사인 유사도)
echo "[4/4] Creating Vectorize Index (1024-dim, cosine)..."
wrangler vectorize create "malgn-chatbot-vectors-${TENANT_ID}" \
  --dimensions=1024 --metric=cosine
echo ""

# 새 API 키 자동 생성
NEW_API_KEY=$(openssl rand -hex 20)

echo "============================================"
echo "✓ Cloudflare 리소스 생성 완료"
echo "============================================"
echo ""
echo "▶ wrangler.toml 에 다음 블록을 추가하세요:"
echo ""
cat <<EOF
# ============================================
# Tenant: ${TENANT_ID}
# 배포: wrangler deploy --env ${TENANT_ID}
# URL: malgn-chatbot-api-${TENANT_ID}.workers.dev
# ============================================

[env.${TENANT_ID}]
name = "malgn-chatbot-api-${TENANT_ID}"
vars = { ENVIRONMENT = "production", TENANT_ID = "${TENANT_ID}" }

[env.${TENANT_ID}.ai]
binding = "AI"
gateway = { id = "malgn-chatbot", cache_ttl = 3600 }

[[env.${TENANT_ID}.hyperdrive]]
binding = "HYPERDRIVE"
id = "${HD_ID}"

[[env.${TENANT_ID}.kv_namespaces]]
binding = "KV"
id = "${KV_ID}"

[[env.${TENANT_ID}.r2_buckets]]
binding = "BUCKET"
bucket_name = "malgn-chatbot-files-${TENANT_ID}"

[[env.${TENANT_ID}.vectorize]]
binding = "VECTORIZE"
index_name = "malgn-chatbot-vectors-${TENANT_ID}"

[env.${TENANT_ID}.triggers]
crons = ["*/5 * * * *"]
EOF
echo ""

echo "============================================"
echo "▶ 다음 단계 (순서대로 실행)"
echo "============================================"
echo ""
echo "1. wrangler.toml 에 위 블록 복사"
echo ""
echo "2. MySQL 스키마 적용 (mysql 클라이언트로 직접 실행):"
echo "   mysql -h <HOST> -P 3306 -u <USER> -p <DATABASE> < ./schema.mysql.sql"
echo ""
echo "3. API Key 시크릿 등록 (자동 생성된 새 키 사용):"
echo "   echo '${NEW_API_KEY}' | wrangler secret put API_KEY --env ${TENANT_ID}"
echo ""
echo "4. Worker 배포:"
echo "   wrangler deploy --env ${TENANT_ID}"
echo ""
echo "5. 헬스체크:"
echo "   curl https://malgn-chatbot-api-${TENANT_ID}.<your-subdomain>.workers.dev/health"
echo ""
echo "============================================"
echo "▶ 발급된 API Key (호스트 페이지/임베드 위젯에 사용)"
echo "============================================"
echo ""
echo "  ${NEW_API_KEY}"
echo ""
echo "  ※ 이 값을 frontend의 window.MalgnTutor.apiKey 에 넣고,"
echo "    위 3번 단계로 시크릿에도 동일 값 등록해야 합니다."
echo ""
