# Broker image. Needs a real container (not serverless): it holds long-lived WebSocket
# connections and each round's secret board layout, neither of which survives a function
# invocation model.
FROM node:22-slim

WORKDIR /app

# Install deps first so a source-only change doesn't reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Round secrets live here. A PERSISTENT VOLUME MUST BE MOUNTED AT /data — without one, every
# redeploy loses the board layout of any live round, which strands its pool permanently
# (cancelRound is Open-only, so there is no way to refund). See src/store.ts.
#
# Deliberately no Docker `VOLUME` directive: Railway rejects it ("docker VOLUME is not
# supported, use Railway Volumes") because it attaches its own. Create it with
# `railway volume add --mount-path /data`; on other hosts, mount one the platform's way.
ENV ROUND_STORE_DIR=/data/rounds

ENV PORT=8787
EXPOSE 8787

CMD ["node", "dist/index.js"]
