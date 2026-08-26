FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    openssh-client \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/google-cloud.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/google-cloud.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY package*.json ./
RUN npm ci

COPY dist-scanner ./dist-scanner
COPY server ./server

RUN pip install --no-cache-dir -r server/scripts/requirements.txt \
  && pip install --no-cache-dir -r server/scripts/photogrammetry/requirements.txt

EXPOSE 8080

CMD ["node", "server/scanner-host.js"]