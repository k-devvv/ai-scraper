#!/bin/bash
# ============================================================
# ai-scraper — Immediate Security Cleanup Script
# Run this from your repo root: bash fix-now.sh
# ============================================================

set -e

echo "🔍 ai-scraper Security Cleanup"
echo "================================"

# 1. Remove the { file
if [ -f "{" ]; then
  git rm "{"
  echo "✅ Removed accidental { file"
else
  echo "ℹ️  { file already removed"
fi

# 2. Untrack output directory
if git ls-files --error-unmatch output/ > /dev/null 2>&1; then
  git rm -r --cached output/
  echo "✅ Untracked output/ directory"
else
  echo "ℹ️  output/ already untracked"
fi

# 3. Ensure .gitignore entries
GITIGNORE_ENTRIES=(
  ".env"
  "output/"
  "*.log"
  "node_modules/"
  "dist/"
  ".env.local"
  ".env.*.local"
)

for entry in "${GITIGNORE_ENTRIES[@]}"; do
  if ! grep -qF "$entry" .gitignore 2>/dev/null; then
    echo "$entry" >> .gitignore
    echo "✅ Added $entry to .gitignore"
  fi
done

# 4. Run npm audit
echo ""
echo "🔍 Running npm audit..."
npm audit --audit-level=high || echo "⚠️  Vulnerabilities found — run 'npm audit fix'"

# 5. Commit cleanup
git add .gitignore
git diff --cached --quiet || git commit -m "chore: security cleanup — remove artifacts, untrack output, harden .gitignore"

echo ""
echo "📝 Next steps:"
echo "  1. git push"
echo "  2. On GitHub: Settings → About → add description + topics"
echo "  3. Copy files from ai-scraper-plan/src/ into your src/"
echo "  4. Run: npm install zod pino pino-pretty bullmq ioredis dotenv-safe"
echo "  5. Run: npm install -D vitest @vitest/coverage-v8 eslint"
echo ""
echo "✅ Immediate cleanup done."
