ARG NODE_IMAGE
FROM ${NODE_IMAGE}
RUN npm install --prefix /opt/browser --ignore-scripts --no-audit --no-fund playwright@1.63.0-alpha-2026-08-31 \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/browsers /opt/browser/node_modules/.bin/playwright install --with-deps chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
USER 10001:10001
