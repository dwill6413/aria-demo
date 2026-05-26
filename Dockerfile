FROM node:22-alpine
RUN npm install -g pnpm@latest
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile
RUN pnpm approve-builds
COPY . .
EXPOSE 3001
CMD ["node", "server.mjs"]