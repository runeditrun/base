#!/usr/bin/env bash
set -euo pipefail

# Base's Vite/Cloudflare packages need >=22.12; its node --test *.ts commands
# also need default type stripping (22.18+). Keep these pins in cache inputs.
readonly NODE_VERSION=22.20.0
readonly PNPM_VERSION=10.12.4
readonly WORKERD_VERSION=1.20260907.1
readonly PLAYWRIGHT_VERSION=1.63.0
readonly BIN_DIR=/usr/local/bin

fail() { printf 'Bootstrap: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'requires Linux (Ubuntu/Debian with apt-get).'
command -v apt-get >/dev/null || fail 'requires apt-get for browser OS dependencies.'
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) fail "put ${BIN_DIR} on the calling shell PATH before running bootstrap." ;;
esac
if [[ $(id -u) == 0 ]]; then
  root=()
else
  command -v sudo >/dev/null || fail 'requires root or passwordless sudo for system packages and shared binaries.'
  sudo -n true || fail 'requires passwordless sudo.'
  root=(sudo -n)
fi
case $(uname -m) in
  x86_64)
    arch=x64
    checksum=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29 ;;
  aarch64|arm64)
    arch=arm64
    checksum=4181609e03dcb9880e7e5bf956061ecc0503c77a480c6631d868cb1f65a2c7dd ;;
  *) fail 'supported Linux architectures are x86_64 and aarch64.' ;;
esac
readonly node_home="/opt/rer-agent-tools/node-v${NODE_VERSION}-linux-${arch}"
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly repo_root
cd "$repo_root"

"${root[@]}" apt-get update
"${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git libatomic1 python3 tar unzip
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
"${root[@]}" env GITLEAKS_INSTALL_DIR="$BIN_DIR" bash "$repo_root/scripts/install-gitleaks.sh"
if [[ ! -x "$node_home/bin/node" ]] || [[ $("$node_home/bin/node" --version) != "v${NODE_VERSION}" ]]; then
  archive="node-v${NODE_VERSION}-linux-${arch}.tar.gz"
  curl --fail --silent --show-error --location --retry 5 --retry-all-errors --retry-delay 5 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "$scratch/$archive"
  printf '%s  %s\n' "$checksum" "$scratch/$archive" | sha256sum --check --strict
  "${root[@]}" mkdir -p /opt/rer-agent-tools
  "${root[@]}" tar -xzf "$scratch/$archive" -C /opt/rer-agent-tools
fi
"${root[@]}" mkdir -p "$BIN_DIR"
for command_name in node npm npx; do
  "${root[@]}" ln -sfn "$node_home/bin/$command_name" "$BIN_DIR/$command_name"
done
hash -r
[[ $(node --version) == "v${NODE_VERSION}" ]] || fail "another Node shadows ${BIN_DIR}/node; move ${BIN_DIR} first on the calling shell PATH."
if [[ ! -x "$node_home/bin/pnpm" ]] || [[ $("$node_home/bin/pnpm" --version) != "$PNPM_VERSION" ]]; then
  "${root[@]}" "$node_home/bin/node" "$node_home/lib/node_modules/npm/bin/npm-cli.js" \
    install --global --prefix "$node_home" "pnpm@${PNPM_VERSION}" --no-audit --no-fund
fi
"${root[@]}" ln -sfn "$node_home/bin/pnpm" "$BIN_DIR/pnpm"
hash -r
[[ $(pnpm --version) == "$PNPM_VERSION" ]] || fail "another pnpm shadows ${BIN_DIR}/pnpm; move ${BIN_DIR} first on the calling shell PATH."

# Use the default shared store. Permit the locked native binary installers,
# without modifying the workspace/package/lock files or permitting all builds.
pnpm --config.only-built-dependencies=esbuild --config.only-built-dependencies=workerd \
  install --frozen-lockfile
pnpm --dir modules/mail install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm --dir default-seed exec playwright install --with-deps chromium

# Resolve the actual locked Wrangler runtime and launch the actual Chromium.
# These checks fail if an optional native binary or an OS library is missing.
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
const require = createRequire(realpathSync('default-seed/node_modules/wrangler/package.json'))
const runtime = require.resolve('workerd/package.json')
assert.equal(require(runtime).version, '1.20260907.1')
execFileSync(resolve(dirname(runtime), 'bin/workerd'), ['--version'], { stdio: 'inherit' })
const browserRequire = createRequire(resolve('default-seed/package.json'))
assert.equal(browserRequire('@playwright/test/package.json').version, '1.63.0')
const { chromium } = browserRequire('@playwright/test')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto('data:text/html,<title>Bootstrap browser probe</title>')
  assert.equal(await page.title(), 'Bootstrap browser probe')
  console.log(`Chromium ${browser.version()} launched successfully`)
} finally {
  await browser.close()
}
NODE
printf 'Ready: %s; Node %s; pnpm %s; Playwright %s; workerd %s\n' \
  "$(git --version)" "$NODE_VERSION" "$PNPM_VERSION" "$PLAYWRIGHT_VERSION" "$WORKERD_VERSION"
printf 'Verify from the repository root: pnpm verify\n'
