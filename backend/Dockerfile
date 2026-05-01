FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data /app/uploads

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/api/health || exit 1

CMD ["npm", "start"]
