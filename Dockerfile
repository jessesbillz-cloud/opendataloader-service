FROM node:20-bookworm-slim

# Install only what we need:
# - Java 17 headless (for OpenDataLoader)
# - LibreOffice Writer only (for DOCX → PDF)
# - ImageMagick (for image → PDF)
# - Build tools (for sharp native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    libreoffice-writer-nogui \
    imagemagick \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Allow ImageMagick to read/write PDFs
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml 2>/dev/null || true

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
RUN mkdir -p /tmp/uploads

EXPOSE 3000
CMD ["node", "server.js"]
