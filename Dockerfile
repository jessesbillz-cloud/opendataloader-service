FROM node:20-slim

# Install Java 17 (required by OpenDataLoader), LibreOffice, ImageMagick,
# and build tools for native npm modules (sharp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    libreoffice-nogui \
    imagemagick \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Allow ImageMagick to convert PDFs (disabled by default in policy.xml)
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml 2>/dev/null || true

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY server.js ./

# Create upload dir
RUN mkdir -p /tmp/uploads

EXPOSE 3000

CMD ["node", "server.js"]
