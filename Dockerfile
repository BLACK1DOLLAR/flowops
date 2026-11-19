# --- build: compile the server and the editor ---------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# --- runtime: server + built editor, production dependencies only --------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5175
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/db server/db
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
RUN mkdir -p data && chown -R node:node data
USER node
EXPOSE 5175
VOLUME ["/app/server/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:5175/health || exit 1
CMD ["node", "dist/index.js"]
