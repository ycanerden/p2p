#!/bin/bash
set -e

# Deploy Walkie-Talkie to Railway, Render, or self-hosted

echo "🚀 Walkie-Talkie Deployment"
echo ""

# Check if running in CI/CD
if [ -z "$DEPLOY_TARGET" ]; then
  echo "Select deployment target:"
  echo "  1) Railway (recommended, 5MB free, $5/mo)"
  echo "  2) Render (free tier with 15-min auto-stop)"
  echo "  3) Self-hosted (Docker)"
  echo ""
  read -p "Choice [1-3]: " CHOICE
  DEPLOY_TARGET=$CHOICE
fi

case $DEPLOY_TARGET in
  1|railway)
    echo "📍 Deploying to Railway..."
    echo ""
    echo "Prerequisites:"
    echo "  - Railway CLI installed: npm install -g @railway/cli"
    echo "  - Logged in: railway login"
    echo ""

    if ! command -v railway &> /dev/null; then
      echo "❌ Railway CLI not found. Install with:"
      echo "   npm install -g @railway/cli"
      exit 1
    fi

    echo "1️⃣  Creating Railway project..."
    railway up --detach || true

    echo "2️⃣  Deploying from railway.toml..."
    railway deploy

    echo ""
    echo "✅ Deployed! Check status:"
    echo "   railway status"
    echo ""
    echo "Get your URL:"
    echo "   railway env | grep RAILWAY_PUBLIC_DOMAIN"
    ;;

  2|render)
    echo "📍 Deploying to Render..."
    echo ""
    echo "Prerequisites:"
    echo "  - Render CLI installed: npm install -g render-cli"
    echo "  - Or use Render Dashboard: https://dashboard.render.com"
    echo ""
    echo "Option A (CLI):"
    echo "  1. render-cli deploy"
    echo ""
    echo "Option B (Dashboard):"
    echo "  1. Create Web Service → GitHub → walkie-talkie repo"
    echo "  2. Build command: bun install"
    echo "  3. Start command: bun run src/index.ts"
    echo "  4. Port: 8080"
    echo "  5. Deploy"
    echo ""
    echo "render.yaml is pre-configured. Use it for IaC:"
    echo "  1. Link repo to Render"
    echo "  2. Deploy from repo settings"
    ;;

  3|self)
    echo "📍 Self-Hosted Docker"
    echo ""
    echo "Build image:"
    echo "  docker build -t walkie-talkie ."
    echo ""
    echo "Run locally:"
    echo "  docker run -p 8080:8080 \\"
    echo "    -e PORT=8080 \\"
    echo "    -e NODE_ENV=production \\"
    echo "    walkie-talkie"
    echo ""
    echo "Run with persistence:"
    echo "  docker run -p 8080:8080 \\"
    echo "    -v walkie-db:/app/data \\"
    echo "    -e PORT=8080 \\"
    echo "    walkie-talkie"
    echo ""
    echo "Push to registry:"
    echo "  docker tag walkie-talkie YOUR_REGISTRY/walkie-talkie:latest"
    echo "  docker push YOUR_REGISTRY/walkie-talkie:latest"
    ;;

  *)
    echo "❌ Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "📖 After deployment:"
echo "   1. Get your server URL"
echo "   2. Run: ./quick-start.sh"
echo "   3. Update server URL if needed"
echo ""
echo "✅ You're live!"
