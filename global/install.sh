#!/bin/sh
# Install the rer command (@runeditrun/rer) for this user:
#
#   curl -fsSL https://runeditrun.com/install.sh | sh
#   curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev owner/repo
#
# It reads the version, tarball and sha512 integrity from the npm registry
# (npm_config_registry, default https://registry.npmjs.org; RER_VERSION=X pins an
# exact version, otherwise latest), verifies the download, refuses archives with
# absolute paths, .. entries, links or devices (and anything tar could read
# differently from this script's own check), and installs through the
# package's own `rer cli install`: the same layout as
# `npx -y @runeditrun/rer cli install`. A failure leaves any previous install
# selected and working. It never edits shell profiles.
#
# Needs curl and tar. If Node 22 or later is absent, installs the pinned official
# Node release in rer's own data directory. macOS/Linux x64/arm64; Windows: WSL2.

# Everything runs from main, so a partly downloaded script does nothing.
main() {
 set -eu
 if [ "${1:-}" = -- ]; then shift; fi
 package='@runeditrun/rer'

 case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux | Darwin) ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) fail 'native Windows is not supported; run this inside WSL2 (https://learn.microsoft.com/windows/wsl/install).' ;;
  *) fail "this system ($(uname -s 2>/dev/null || echo unknown)) is not supported; rer runs on macOS and Linux (on Windows, inside WSL2)." ;;
 esac
 case "$(uname -m)" in
  x86_64 | amd64 | arm64 | aarch64) ;;
  *) fail "this processor ($(uname -m)) is not supported; rer runs on x64 and arm64." ;;
 esac
 for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required. Install it, then run this again."
 done

 registry=${npm_config_registry:-https://registry.npmjs.org}
 registry=${registry%/}
 work=$(mktemp -d "${TMPDIR:-/tmp}/rer-install.XXXXXX")
 trap 'rm -rf "$work"' EXIT
 trap 'exit 130' INT TERM

 # Bootstrap before reading npm metadata; no npm global install or PATH links.
 if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  install_node
 fi

 curl -fsSL --proto '=http,https' -H 'Accept: application/json' "$registry/@runeditrun%2frer" -o "$work/metadata.json" \
  || fail "could not read $package from $registry."
 # Writes version, tarball URL, integrity, file count and unpacked size, one per line.
 node - "$work/metadata.json" "${RER_VERSION:-}" >"$work/release" <<'NODE' || exit 1
var fs = require('fs');
var wanted = process.argv[3];
function stop(message) { process.stderr.write('rer install: ' + message + '\n'); process.exit(1); }
var metadata;
try { metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (error) { stop('the registry answered with something that is not package metadata.'); }
var version = wanted || (metadata['dist-tags'] || {}).latest;
var release = (metadata.versions || {})[version];
if (!release) stop(wanted ? 'version ' + wanted + ' of @runeditrun/rer is not published.' : 'the registry names no latest version of @runeditrun/rer.');
var dist = release.dist || {};
if (!/^sha512-[A-Za-z0-9+\/]+=*$/.test(dist.integrity || '')) stop('the registry gives no sha512 integrity for ' + version + '.');
if (!dist.tarball) stop('the registry gives no tarball for ' + version + '.');
var minimum = String((release.engines || {}).node || '0').replace(/^>=\s*/, '');
var have = process.versions.node.split('.').map(Number), need = minimum.split('.').map(Number);
for (var i = 0; i < 3; i++) {
 if ((have[i] || 0) > (need[i] || 0)) break;
 if ((have[i] || 0) < (need[i] || 0)) stop('rer ' + version + ' needs Node ' + minimum + ' or later; this is Node ' + process.versions.node + '. Install a newer Node, then run this again.');
}
process.stdout.write([version, dist.tarball, dist.integrity, dist.fileCount === undefined ? '' : dist.fileCount, dist.unpackedSize === undefined ? '' : dist.unpackedSize].join('\n') + '\n');
NODE
 { read -r version; read -r tarball; read -r integrity; read -r files; read -r size; } <"$work/release"

 printf 'Downloading rer %s from %s\n' "$version" "$registry"
 curl -fsSL --proto '=http,https' "$tarball" -o "$work/rer.tgz" || fail "could not download $tarball."
 # The exact bytes the registry names, and nothing tar could write outside its folder.
 node - "$work/rer.tgz" "$integrity" "$files" "$size" <<'NODE' || fail "the download of rer $version was refused; nothing was installed."
var fs = require('fs'), hashes = require('crypto'), zlib = require('zlib');
function stop(message) { process.stderr.write('rer install: ' + message + '\n'); process.exit(1); }
var bytes = fs.readFileSync(process.argv[2]);
if ('sha512-' + hashes.createHash('sha512').update(bytes).digest('base64') !== process.argv[3]) stop('the download does not match the registry\'s sha512 integrity.');
var tar;
try { tar = zlib.gunzipSync(bytes); } catch (error) { stop('the download is not a gzip archive.'); }
function text(block, start, length) { var end = start; while (end < start + length && block[end] !== 0) end++; return block.toString('utf8', start, end); }
function zero(bytes) { for (var z = 0; z < bytes.length; z++) if (bytes[z] !== 0) return false; return true; }
// tar reads a pax extended header too; only path and size (both honoured here)
// and mtime (only a time) may appear, so both readers see the same entries.
function paxFields(data) {
 var fields = {}, at = 0;
 while (at < data.length) {
  var space = data.indexOf(0x20, at), digits = space === -1 ? '' : data.toString('latin1', at, space), length = Number(digits);
  if (!/^[1-9][0-9]*$/.test(digits) || at + length <= space + 1 || at + length > data.length || data[at + length - 1] !== 0x0a) stop('the archive has a damaged extended header.');
  var record = data.toString('utf8', space + 1, at + length - 1), equals = record.indexOf('='), key = record.slice(0, equals), value = record.slice(equals + 1);
  at += length;
  if (equals < 1) stop('the archive has a damaged extended header.');
  if (key === 'linkpath') stop('the archive contains a link.');
  if (key === 'size' && !/^[0-9]+$/.test(value)) stop('the archive has a damaged extended header.');
  if (key !== 'path' && key !== 'size' && key !== 'mtime') stop('the archive has an extended header field this installer does not read (' + key + ').');
  fields[key] = key === 'size' ? Number(value) : value;
 }
 return fields;
}
var offset = 0, count = 0, total = 0, pax = null, ended = false;
while (offset + 512 <= tar.length) {
 var block = tar.subarray(offset, offset + 512);
 if (zero(block)) {
  if (!zero(tar.subarray(offset))) stop('the archive has data after its end.');
  ended = true;
  break;
 }
 var sum = 0;
 for (var i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
 if (parseInt(text(block, 148, 8), 8) !== sum) stop('the archive has a damaged header.');
 if (block.toString('latin1', 257, 265) !== 'ustar\u0000' + '00') stop('the archive is not a ustar archive.');
 var sizeField = text(block, 124, 12).trim();
 if (!/^[0-7]+$/.test(sizeField)) stop('the archive has a damaged header.');
 var type = String.fromCharCode(block[156] || 48), length = type !== 'x' && pax && pax.size !== undefined ? pax.size : parseInt(sizeField, 8);
 var data = tar.subarray(offset + 512, offset + 512 + length);
 if (data.length < length) stop('the archive is truncated.');
 offset += 512 + Math.ceil(length / 512) * 512;
 if (type === 'x') {
  if (pax) stop('the archive has two extended headers for one entry.');
  pax = paxFields(data);
  continue;
 }
 var name = pax && pax.path !== undefined ? pax.path : text(block, 345, 155) ? text(block, 345, 155) + '/' + text(block, 0, 100) : text(block, 0, 100);
 pax = null;
 if (type !== '0' && type !== '5') stop('the archive contains a link, device or other special entry (' + name + ').');
 if (name.charAt(0) === '/' || name.split('/').indexOf('..') !== -1 || name.indexOf('\\') !== -1 || name.split('/')[0] !== 'package') stop('the archive contains an unsafe path (' + name + ').');
 if (type === '5' && length !== 0) stop('the archive gives the folder ' + name + ' contents.');
 if (type === '0' && name.charAt(name.length - 1) === '/') stop('the archive gives the file ' + name + ' a folder\'s name.');
 // The registry's file count counts every entry, folders included.
 count++;
 total += length;
}
if (!ended || pax) stop('the archive is truncated.');
if (process.argv[4] !== '' && Number(process.argv[4]) !== count) stop('the archive holds ' + count + ' entries; the registry says ' + process.argv[4] + '.');
if (process.argv[5] !== '' && Number(process.argv[5]) !== total) stop('the archive unpacks to ' + total + ' bytes; the registry says ' + process.argv[5] + '.');
NODE
 mkdir "$work/stage"
 tar -xzf "$work/rer.tgz" -C "$work/stage" || fail "could not unpack rer $version; nothing was installed."
 RER_INSTALL_CHANNEL=script node "$work/stage/package/global/rer.mjs" cli install </dev/null \
  || fail "rer cli install failed; any previous install is still selected."
 if [ "$#" -gt 0 ]; then
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  "$HOME/.local/bin/rer" "$@"
 fi
}

install_node() {
 node_version=22.20.0
 case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; esac
 case "$(uname -m)" in x86_64 | amd64) node_arch=x64 ;; arm64 | aarch64) node_arch=arm64 ;; esac
 node_name="node-v$node_version-$node_os-$node_arch"
 data="${XDG_DATA_HOME:-$HOME/.local/share}/rer"
 node_home="$data/runtimes/$node_name"
 if [ ! -x "$node_home/bin/node" ] || [ "$("$node_home/bin/node" --version 2>/dev/null)" != "v$node_version" ]; then
  printf 'Installing Node %s in %s from the checksum-verified nodejs.org release.\n' "$node_version" "$node_home"
  archive="$node_name.tar.gz"
  release="https://nodejs.org/dist/v$node_version"
  curl -fsSL --proto '=https' "$release/SHASUMS256.txt" -o "$work/SHASUMS256.txt" \
   || fail "could not download Node $node_version checksums from nodejs.org."
  curl -fL --proto '=https' "$release/$archive" -o "$work/$archive" \
   || fail "could not download Node $node_version from nodejs.org."
  expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$work/SHASUMS256.txt")
  [ "${#expected}" -eq 64 ] || fail "nodejs.org gives no unique SHA-256 for $archive."
  case "$expected" in *[!0-9a-f]*) fail "nodejs.org gives an invalid SHA-256 for $archive." ;; esac
  if command -v shasum >/dev/null 2>&1; then
   actual=$(shasum -a 256 "$work/$archive")
  elif command -v sha256sum >/dev/null 2>&1; then
   actual=$(sha256sum "$work/$archive")
  else
   fail 'SHA-256 verification needs shasum or sha256sum. Install one, then run this again.'
  fi
  [ "${actual%% *}" = "$expected" ] || fail "Node $node_version does not match nodejs.org's SHA-256; nothing was installed."
  mkdir "$work/node"
  tar -xzf "$work/$archive" -C "$work/node" || fail "could not unpack Node $node_version."
  [ "$("$work/node/$node_name/bin/node" --version)" = "v$node_version" ] || fail "Node $node_version cannot run on this system."
  mkdir -p "$data/runtimes"
  # Move only into our prefix, and never overlay an existing runtime.
  [ ! -e "$node_home" ] || fail "the private Node runtime at $node_home is damaged; remove that directory and run this again."
  mv "$work/node/$node_name" "$node_home"
 fi
 # A private link lets future launchers and updates find the managed runtime.
 # Node's rename replaces an existing symlink atomically on macOS and Linux.
 "$node_home/bin/node" - "$data" "$node_name" <<'NODE' || exit 1
var fs = require('fs'), path = require('path');
var root = process.argv[2], temporary = path.join(root, '.node-' + process.pid);
try {
 fs.symlinkSync(path.join('runtimes', process.argv[3]), temporary);
 fs.renameSync(temporary, path.join(root, 'node'));
} finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
NODE
 PATH="$node_home/bin:$PATH"
 export PATH
}

fail() {
 printf 'rer install: %s\n' "$*" >&2
 exit 1
}

main "$@"
