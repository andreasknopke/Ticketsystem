FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

ENV PORT=8010
ENV DB_FILE=/app/data/tickets.db

EXPOSE 8010

CMD ["npm", "start"]