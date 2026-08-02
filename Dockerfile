FROM node:26-bookworm-slim AS ui-build

WORKDIR /build/ui_web
COPY ui_web/package.json ui_web/package-lock.json ./
RUN npm ci
COPY ui_web/ ./
RUN npm run build


FROM python:3.13-slim-bookworm AS python-build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.docker.lock ./
RUN pip wheel --require-hashes --wheel-dir /wheels -r requirements.docker.lock


FROM python:3.13-slim-bookworm AS runtime

ARG SOUNDSIBLE_VERSION=0.0.0-docker
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Soundsible" \
      org.opencontainers.image.description="Private, self-hosted music streaming server" \
      org.opencontainers.image.source="https://github.com/Arzuparreta/soundsible" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${SOUNDSIBLE_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SOUNDSIBLE_VERSION=${SOUNDSIBLE_VERSION} \
    SOUNDSIBLE_HOST=0.0.0.0 \
    SOUNDSIBLE_PORT=5005 \
    SOUNDSIBLE_CONFIG_DIR=/config \
    SOUNDSIBLE_DATA_DIR=/data \
    SOUNDSIBLE_CACHE_DIR=/cache \
    SOUNDSIBLE_LOG_DIR=/logs \
    SOUNDSIBLE_MUSIC_DIR=/music \
    OUTPUT_DIR=/music \
    SOUNDSIBLE_UI_DIST=/app/ui_web/dist \
    SOUNDSIBLE_SKIP_UI_BUILD=1 \
    SOUNDSIBLE_LAN_ENABLED=true \
    SOUNDSIBLE_ADVANCED_MODE=true \
    SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE=true

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 soundsible \
    && useradd --uid 1000 --gid soundsible --create-home --shell /usr/sbin/nologin soundsible

COPY --from=python-build /wheels /wheels
RUN pip install --no-cache-dir --no-compile /wheels/* \
    && rm -rf /wheels

WORKDIR /app
COPY --chown=soundsible:soundsible __init__.py soundsible_engine.py ./
COPY --chown=soundsible:soundsible shared ./shared
COPY --chown=soundsible:soundsible player ./player
COPY --chown=soundsible:soundsible odst_tool ./odst_tool
COPY --chown=soundsible:soundsible setup_tool ./setup_tool
COPY --chown=soundsible:soundsible branding ./branding
COPY --chown=soundsible:soundsible --from=ui-build /build/ui_web/dist ./ui_web/dist

RUN mkdir -p /config /data /cache /logs /music \
    && chown -R soundsible:soundsible /config /data /cache /logs /music

USER soundsible
EXPOSE 5005
VOLUME ["/config", "/data", "/cache", "/logs", "/music"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["python", "-c", "import json, os, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('SOUNDSIBLE_PORT', '5005') + '/api/health', timeout=4); assert response.status == 200 and json.load(response).get('status') == 'healthy'"]

CMD ["python", "-m", "shared.container_entrypoint"]
