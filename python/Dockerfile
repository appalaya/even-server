# Even sync server, Python reference.
# UNTESTED: written without Docker available. The same commands are tested
# outside Docker (see README.md); please report anything that breaks here.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY pyproject.toml README.md ./
COPY even_server ./even_server
RUN pip install --no-deps . && rm -rf build *.egg-info

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin even \
 && mkdir -p /data && chown even:even /data
USER even

# Listen on all interfaces inside the container; docker-compose.yml publishes
# the port on the host's loopback only, for a reverse proxy on the same host.
ENV EVEN_DB_PATH=/data/even.db \
    EVEN_HOST=0.0.0.0 \
    EVEN_PORT=8787
VOLUME ["/data"]
EXPOSE 8787

CMD ["even-server"]
