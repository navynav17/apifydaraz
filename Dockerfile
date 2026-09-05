FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /usr/src/app
COPY package.json ./
RUN npm install --omit=dev
COPY main.ts ./
COPY INPUT_SCHEMA.json ./

CMD ["npm","start"]
