#!/bin/sh
set -eu
umask 077
mkdir -p /data
# Keep this same lock inode held through template copying and the host lifetime.
exec flock --nonblock --no-fork /data/host.lock sh -ec '
 node /runtime/modules/demo-host/template.mjs /template /data
 exec node /runtime/modules/container/host.mjs "$@"
' sh "$@"
