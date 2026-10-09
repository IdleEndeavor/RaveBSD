FROM node:24-slim
WORKDIR /app

# The browser is used for Z-Library searches without an account and for Anna's Archive. For a much
# smaller image without it, build with: docker compose build --build-arg WITH_BROWSER=0
ARG WITH_BROWSER=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN if [ "$WITH_BROWSER" = "1" ]; then \
        npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; \
    else \
        npm ci --omit=dev --omit=optional --ignore-scripts; \
    fi

COPY src ./src
COPY public ./public

# BUILD_ID is the git commit, passed in by the publish workflow. It is shown on the Backend page.
ARG BUILD_ID=
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data BROWSER_IN_CONTAINER=1 BUILD_ID=$BUILD_ID
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
