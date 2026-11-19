
FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium --only-shell

COPY server.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]
