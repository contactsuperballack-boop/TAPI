# TAPI API / workers image. One image, different commands:
#   api      : node src/server.js            (default)
#   poller   : node src/scripts/pollBookings.js
#   outbox   : node src/scripts/dispatchOutbox.js
#   migrate  : node src/db/migrate.js        (run once per release, before the others)
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY console ./console
COPY web/dist ./web/dist
COPY openapi.yaml ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
