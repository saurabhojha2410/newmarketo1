# Use the official Playwright image that has browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy backend source
COPY backend/ ./

# Copy frontend
COPY frontend/ ./frontend/

# Create required directories
RUN mkdir -p uploads screenshots

# Expose port
EXPOSE 10000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=10000

# Start the application
CMD ["node", "server.js"]
