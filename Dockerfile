# slimcp as a container: an MCP stdio server that needs no network at runtime.
#
#   docker build -t slimcp .
#   docker run -i --rm slimcp                       # empty config: find_tools, call_tool, slimcp_status
#   docker run -i --rm -v ~/.slimcp/config.json:/config/slimcp.json:ro slimcp
#
# With no upstream servers configured it still starts and lists its meta-tools,
# which is what MCP registries (e.g. Glama) use to introspect it.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    SLIMCP_HOME=/tmp/slimcp
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /config && printf '{\n  "servers": {}\n}\n' > /config/slimcp.json
USER node
ENTRYPOINT ["node", "/app/dist/cli.js", "serve", "--config", "/config/slimcp.json"]
