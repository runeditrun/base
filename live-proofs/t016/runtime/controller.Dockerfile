# Build in a credential-free environment, inspect the complete tool dependency
# closure, then record the resulting OCI digest in T016_CONTROLLER_IMAGE.
# NODE_IMAGE must be a reviewed node:26.8.1-bookworm-slim@sha256:<digest>.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
RUN npm install --prefix /opt/trusted --ignore-scripts --no-audit --no-fund pnpm@10.12.4 wrangler@4.129.1 \
 && mkdir -p /opt/trusted/bin /mediator \
 && ln -s /opt/trusted/node_modules/.bin/pnpm /opt/trusted/bin/pnpm \
 && ln -s /opt/trusted/node_modules/.bin/wrangler /opt/trusted/bin/wrangler \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /controller/mediator.mjs "$@"\n' > /mediator/pnpm \
 && chmod 755 /mediator/pnpm
USER 10001:10001
