# Crawler / question-bank builder. Run as a job, not a service:
#   docker compose run --rm crawler build
#
# Build context is the repository root, so `shared/schema.sql` is reachable.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY crawler/pyproject.toml ./
COPY crawler/beecrawl ./beecrawl
RUN pip install --no-cache-dir .

# The schema is shared with the web app and applied on every crawler run.
COPY shared ./shared

ENV BEE_DATA_DIR=/data \
    BEE_DB_PATH=/data/bee.db \
    BEE_CACHE_DIR=/data/cache \
    BEE_INBOX_DIR=/data/inbox \
    BEE_SCHEMA_PATH=/app/shared/schema.sql

# The crawler writes only to the mounted volume; it does not need root.
RUN useradd --create-home --uid 10001 bee && mkdir -p /data /opt/bee \
    && chown -R bee /data /app /opt/bee

# The database baked into the image, built by `crawler seed`.
#
# /opt/bee, never /data — a volume mounted at /data would hide a seed placed
# inside it and the container would come up with nothing. It is copied into
# place on first boot instead, which populates a fresh volume while keeping
# everything written afterwards.
#
# The `data/seed.db*` glob may match nothing; schema.sql is listed alongside it
# only so COPY always has at least one source, which Docker requires. Without
# a seed the build still succeeds and the app simply starts empty.
COPY shared/schema.sql data/seed.db* /opt/bee/staged/
RUN mkdir -p /opt/bee \
    && if [ -f /opt/bee/staged/seed.db ]; then mv /opt/bee/staged/seed.db /opt/bee/seed.db; fi \
    && rm -rf /opt/bee/staged \
    && chown -R bee /opt/bee
ENV BEE_SEED_DB=/opt/bee/seed.db

USER bee

ENTRYPOINT ["python", "-m", "beecrawl.cli"]
CMD ["--help"]
