# PayWave API service for Kubernetes (sign-up, profile, history, notifications, AutoPay setup).
# Money movement runs in AWS Lambda; this image serves ROUTE_MODE=core.
FROM node:22-alpine
ENV NODE_ENV=production ROUTE_MODE=core PORT=3000
WORKDIR /app
COPY package.json ./
# Lambda provides the AWS SDK at runtime; a container has to install it itself
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund @aws-sdk/client-secrets-manager@^3.700.0 \
 && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY server.js ./
USER node
EXPOSE 3000 9100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
