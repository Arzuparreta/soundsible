# Only static browser assets leave this stage. Run Node/Vite natively rather
# than under QEMU when the runtime image targets another architecture.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS ui-build

WORKDIR /build/ui_web
COPY ui_web/package.json ui_web/package-lock.json ./
RUN npm ci
COPY ui_web/ ./
# The HTML startup screen embeds the canonical logo during the Vite build.
COPY branding/logo-mark.svg /build/branding/logo-mark.svg
RUN npm run build


FROM python:3.13-slim-trixie AS python-build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.docker.lock ./
RUN pip wheel --require-hashes --wheel-dir /wheels -r requirements.docker.lock


# The Auto DJ beat model: a Soundsible release asset with a fixed SHA-256,
# fetched and verified by the same script desktop builds and CI use.
FROM --platform=$BUILDPLATFORM python:3.13-slim-trixie AS dj-model

WORKDIR /build
COPY scripts/fetch_dj_model.py scripts/
COPY shared/dj/weights.py shared/dj/
RUN python scripts/fetch_dj_model.py --output /build/models/beat_this-final0.onnx


FROM python:3.13-slim-trixie AS runtime

# Left empty on purpose. An arg-less build then reports the version that
# shared/version.py declares, instead of inventing a second answer that only
# containers ever gave. CI passes the real one.
ARG SOUNDSIBLE_VERSION=
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Soundsible" \
      org.opencontainers.image.description="Self-hosted music service with catalog search, acquisition, local discovery, and Auto DJ mixing" \
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
    && apt-get install --no-install-recommends -y ffmpeg \
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
COPY --chown=soundsible:soundsible setup_tool ./setup_tool
COPY --chown=soundsible:soundsible branding ./branding
COPY --chown=soundsible:soundsible --from=ui-build /build/ui_web/dist ./ui_web/dist
COPY --chown=soundsible:soundsible --from=dj-model /build/models ./models

RUN mkdir -p /config /data /cache /logs /music \
    && chown -R soundsible:soundsible /config /data /cache /logs /music

USER soundsible
EXPOSE 5005
VOLUME ["/config", "/data", "/cache", "/logs", "/music"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["python", "-c", "import json, os, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('SOUNDSIBLE_PORT', '5005') + '/api/health', timeout=4); assert response.status == 200 and json.load(response).get('status') == 'healthy'"]

CMD ["python", "-m", "shared.container_entrypoint"]
