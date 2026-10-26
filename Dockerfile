# Build stage: install everything, compile TS, then strip dev deps.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: dist + production node_modules only, non-root user.
# Config (DATABASE_URL, FIREBASE_PROJECT_ID, PORT) comes from Cloud Run
# env/secrets — no .env is ever baked in (see .dockerignore).
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
