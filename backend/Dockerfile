# PayWave API service for Kubernetes (sign-up, profile, history, notifications, AutoPay setup).
# Money movement runs in AWS Lambda; this image serves ROUTE_MODE=core.
FROM node:22-alpine
ENV NODE_ENV=production ROUTE_MODE=core PORT=3000
WORKDIR /app
COPY package.json ./
# Lambda provides the AWS SDK at runtime, so package.json lists it under devDependencies.
# A container has to ship it itself, hence --include=dev (it is the only devDependency).
# NODE_ENV=production would otherwise silently drop it, even if installed by name.
RUN npm install --include=dev --ignore-scripts --no-audit --no-fund \
 && node -e "require('pg'); require('@aws-sdk/client-secrets-manager')" \
 && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY server.js ./
USER node
EXPOSE 3000 9100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
