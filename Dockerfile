FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production
RUN npx prisma generate
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["npm", "start"]
