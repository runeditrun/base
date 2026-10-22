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

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
# Keep archives outside Docker's /var/cache/apt cleanup hook. The workflow
# restores this directory only after recording the clean-container preconditions.
readonly apt_archives="$HOME/.cache/rer-apt/archives"
mkdir -p "$apt_archives"
readonly apt_config="$scratch/apt.conf"
readonly apt_base_config="$scratch/apt-base.conf"
cat > "$apt_base_config" <<APT
Dir::Cache::archives "$apt_archives";
APT::Keep-Downloaded-Packages "true";
APT::Update::Error-Mode "any";
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
# A hosted runner's Azure mirror path can hang on package downloads while its
# index fetches work, so a fresh connection to the same host does not recover.
# Attempt 1 keeps the configured mirrors; attempts 2 and 3 use these other
# mirrors of the same Ubuntu-signed archive (apt still verifies every Release
# signature against the installed keyring). Keep in step with verify.yml.
readonly -a apt_fallback_mirrors=(http://mirrors.edge.kernel.org/ubuntu http://us-east-1.ec2.archive.ubuntu.com/ubuntu)
readonly apt_mirror_host_re='https?://(([a-z0-9.-]+\.)?archive\.ubuntu\.com|security\.ubuntu\.com|mirrors\.edge\.kernel\.org)/ubuntu/?'
apt_mirror_label=
# Point apt at attempt $1's mirrors through scratch copies of the source lists;
# the system's own apt sources are never modified.
apt_select_mirror() {
  local attempt=$1 mirror src dest changed=0
  cp "$apt_base_config" "$apt_config"
  apt_mirror_label=$(sed -nE 's@^(URIs:[[:space:]]*|deb (\[[^]]*\][[:space:]]*)?)(https?://[^/[:space:]]+).*@\3@p' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | head -n 1 || true)
  apt_mirror_label=${apt_mirror_label:-configured-sources}
  (( attempt > 1 )) || return 0
  mirror=${apt_fallback_mirrors[attempt - 2]}
  rm -rf "$scratch/apt-sources"
  mkdir -p "$scratch/apt-sources/parts"
  : > "$scratch/apt-sources/sources.list"
  for src in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    [[ -f $src ]] || continue
    dest="$scratch/apt-sources/parts/${src##*/}"
    [[ $src == /etc/apt/sources.list ]] && dest="$scratch/apt-sources/sources.list"
    sed -E "s@${apt_mirror_host_re}@${mirror}/@g" "$src" > "$dest"
    cmp -s "$src" "$dest" || changed=1
  done
  if (( changed )); then
    printf 'Dir::Etc::sourcelist "%s/apt-sources/sources.list";\nDir::Etc::sourceparts "%s/apt-sources/parts";\n' "$scratch" "$scratch" >> "$apt_config"
    apt_mirror_label=$mirror
  fi
}
apt_phase() {
  local label=$1 status attempt started=$SECONDS
  shift
  # Three fresh connections, including kill grace/backoff, stay below 300s.
  # Keep the archive directory (including partial downloads) across attempts.
  for attempt in 1 2 3; do
    apt_select_mirror "$attempt"
    printf 'Bootstrap apt: %s attempt %s/3 (90s deadline; mirror %s)\n' "$label" "$attempt" "$apt_mirror_label"
    if "${root[@]}" env APT_CONFIG="$apt_config" timeout --kill-after=5s 90s \
      bash -ec 'dpkg --configure -a; "$@"' bash "$@"; then
      printf 'Bootstrap apt: %s complete (attempts=%s mirror=%s seconds=%s)\n' "$label" "$attempt" "$apt_mirror_label" "$((SECONDS - started))"
      return 0
    else
      status=$?
      printf 'Bootstrap apt: %s attempt %s/3 failed (mirror %s, exit %s, seconds=%s)\n' "$label" "$attempt" "$apt_mirror_label" "$status" "$((SECONDS - started))" >&2
    fi
    if (( attempt < 3 )); then sleep "$((attempt * 2))"; fi
  done
  fail "apt phase '$label' failed after 3 attempts (exit $status; 90s per attempt; seconds=$((SECONDS - started))). Inspect the apt download log."
}
apt_phase 'toolchain packages' bash -c '
  apt-get update &&
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git libatomic1 python3 tar unzip
'
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
# Bound apt separately from the browser download, while retaining every OS
# dependency and the real browser/workerd probes below. Pass APT_CONFIG through
# privilege elevation so Playwright's own apt-get uses the same archive cache.
apt_phase 'Chromium OS dependencies' pnpm --dir default-seed exec playwright install-deps chromium
pnpm --dir default-seed exec playwright install chromium

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
