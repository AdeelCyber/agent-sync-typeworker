FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm i --no-save typescript@5.9.3
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json
USER node
ENV HOST=0.0.0.0 PORT=8790
EXPOSE 8790
CMD ["node", "dist/server.js"]
