ARG NODE_IMAGE
FROM ${NODE_IMAGE}
RUN npm install --prefix /opt/trusted --ignore-scripts --no-audit --no-fund pnpm@10.12.4 \
 && mkdir -p /opt/trusted/bin \
 && ln -s /opt/trusted/node_modules/.bin/pnpm /opt/trusted/bin/pnpm
USER 10001:10001
