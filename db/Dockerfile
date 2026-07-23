# Postgres 17 with all three extensions the schema requires:
#   - vector  (pgvector, for semantic dedup / HNSW) — shipped by the base image
#   - ltree   (hierarchical spatial_path)           — shipped by core contrib
#   - postgis (geography(Point,4326) per ADR-8)      — added here
#
# pgvector/pgvector:pg17 is built on the official Debian `postgres:17` image,
# which already carries the PGDG apt repository, so the PostGIS package installs
# without adding a source. The extensions themselves are enabled per-database by
# the migrations (CREATE EXTENSION ...), not here.
FROM pgvector/pgvector:pg17

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-17-postgis-3 \
        postgresql-17-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*
