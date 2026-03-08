#!/usr/bin/env bash
set -euo pipefail

# Emulates a Vercel-style build from a clean working directory copy.
# This is a pragmatic guarantee: if this script passes locally, Vercel is very likely to pass
# given the same Node version and lockfile.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d_%H%M%S)"
WORK_DIR="/tmp/stream-mdx-vercel-parity-${STAMP}"

echo "[vercel-parity] copying repo to ${WORK_DIR}"
mkdir -p "${WORK_DIR}"
rsync -a --delete \
  --exclude "node_modules" \
  --exclude ".next" \
  --exclude "apps/**/.next" \
  --exclude "apps/**/out" \
  --exclude "tmp" \
  --exclude ".git" \
  "${ROOT_DIR}/" "${WORK_DIR}/"

cd "${WORK_DIR}"
echo "[vercel-parity] node=$(node -v) npm=$(npm -v)"

echo "[vercel-parity] npm ci"
npm ci

echo "[vercel-parity] npm run test"
npm run test

echo "[vercel-parity] npm run determinism:matrix"
npm run determinism:matrix

echo "[vercel-parity] npm run determinism:html-parity"
npm run determinism:html-parity

echo "[vercel-parity] npm run docs:build"
npm run docs:build

echo "[vercel-parity] npm run docs:check-links"
DOCS_CHECK_ANCHORS=1 npm run docs:check-links

echo "[vercel-parity] npm run docs:screenshots:smoke"
npm run docs:screenshots:smoke

echo "[vercel-parity] OK"
