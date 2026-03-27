# Mesh v2.0.0 — Bun Dockerfile
FROM oven/bun:1.3.11
WORKDIR /app

# Copy package files
COPY package.json ./
COPY bun.lock* ./

# Install dependencies
RUN bun install

# Copy the rest of the app
COPY . .

# Set env
ENV PORT=8080
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Start the server
CMD ["bun", "run", "src/index.ts"]
