FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY private-media ./private-media
COPY contracts ./contracts
COPY .env.example ./
USER node
EXPOSE 8787
CMD ["npm", "run", "start:api"]
