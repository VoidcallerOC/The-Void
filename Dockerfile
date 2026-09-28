FROM node:22-bookworm-slim AS foundry
ARG FOUNDRY_VERSION=v1.3.1
ARG FOUNDRY_SHA256=baad3e1b06d6f310d210c93e95258a03d923fe610f8d0742138f2245f94abd7c
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION#v}_linux_amd64.tar.gz" -o /tmp/foundry.tar.gz \
    && echo "${FOUNDRY_SHA256}  /tmp/foundry.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/foundry \
    && tar -xzf /tmp/foundry.tar.gz -C /opt/foundry forge \
    && rm /tmp/foundry.tar.gz \
    && /opt/foundry/forge --version

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=foundry /opt/foundry/forge /usr/local/bin/forge
RUN forge --version
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY config ./config
COPY src ./src
COPY scripts ./scripts
COPY private-media ./private-media
COPY contracts ./contracts
COPY .env.example ./
USER node
EXPOSE 8787
CMD ["npm", "run", "start:api"]
