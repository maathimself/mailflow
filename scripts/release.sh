#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version>  (e.g. 1.7.0)"
  exit 1
fi

# Strip leading 'v' if provided
VERSION="${VERSION#v}"
TAG="v${VERSION}"

# Must be on main with a clean tree
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main (currently on $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes"
  exit 1
fi

# Bump version in both package.json files
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" backend/package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" frontend/package.json

git add backend/package.json frontend/package.json
git commit -m "chore: bump version to ${VERSION}"

git tag "${TAG}"

echo ""
echo "Created commit and tag ${TAG}. To push:"
echo "  git push origin main && git push origin ${TAG}"
