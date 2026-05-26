FROM node:20-alpine
RUN npm install -g pnpm@latest
WORKDIR /app
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY . .
EXPOSE 3001
CMD ["node", "server.mjs"]