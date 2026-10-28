FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json eslint.config.js vitest.config.ts ./
COPY src ./src
COPY scenarios ./scenarios
COPY worker ./worker
COPY tests ./tests

RUN npx agboss check && npm run build

CMD ["node", "dist/src/demo.js"]
