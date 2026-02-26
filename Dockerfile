FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY site ./site

RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "run", "start"]
