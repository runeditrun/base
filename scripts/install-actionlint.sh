#!/usr/bin/env bash
set -euo pipefail
readonly version=1.7.7
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=darwin_arm64; checksum=2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db ;;
  Darwin:x86_64) platform=darwin_amd64; checksum=28e5de5a05fc558474f638323d736d822fff183d2d492f0aecb2b73cc44584f5 ;;
  Linux:arm64|Linux:aarch64) platform=linux_arm64; checksum=401942f9c24ed71e4fe71b76c7d638f66d8633575c4016efd2977ce7c28317d0 ;;
  Linux:x86_64) platform=linux_amd64; checksum=023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757 ;;
  *) printf 'actionlint: unsupported platform\n' >&2; exit 1 ;;
esac
install_dir=${ACTIONLINT_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$install_dir"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
archive="actionlint_${version}_${platform}.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}" -o "$scratch/$archive"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$scratch/$archive");
else actual=$(shasum -a 256 "$scratch/$archive"); fi
[[ ${actual%% *} == "$checksum" ]] || { printf 'actionlint: checksum mismatch\n' >&2; exit 1; }
tar -xzf "$scratch/$archive" -C "$scratch" actionlint
install -m 755 "$scratch/actionlint" "$install_dir/actionlint"
printf 'Installed actionlint %s (%s), SHA-256 verified\n' "$version" "$platform"
