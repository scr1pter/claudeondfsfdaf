FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG VECTOR_SOURCE_REVISION
LABEL org.opencontainers.image.title="Vector Cloud workspace engine" \
      org.opencontainers.image.revision=$VECTOR_SOURCE_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 vector && useradd -u 10001 -g 10001 -m vector \
    && mkdir -p /data/config/vector /data/share /data/cache /data/state /data/home /opt/vector \
    && chown -R 10001:10001 /data
RUN printf '%s\n' '#!/usr/bin/python3' 'import pathlib, sys' 'sys.stdout.write("x-access-token" if "sername" in sys.argv[1] else pathlib.Path("/run/git-credential").read_text())' \
    > /usr/local/bin/vector-workspace-askpass \
    && chmod 0755 /usr/local/bin/vector-workspace-askpass
# Build context is prepared from the existing Node engine bundle used by desktop.
# Production deploys this image by its immutable digest, never by a mutable tag.
COPY --chown=10001:10001 engine.mjs entry.mjs /opt/vector/
COPY --chown=10001:10001 *.wasm /opt/vector/
COPY --chown=10001:10001 node_modules /opt/vector/node_modules
COPY LICENSE THIRD_PARTY_NOTICES.md DEPENDENCY_NOTICES.md CONTAINER-INFO.json /usr/share/vector/
ENV HOME=/data/home XDG_CONFIG_HOME=/data/config XDG_DATA_HOME=/data/share XDG_CACHE_HOME=/data/cache XDG_STATE_HOME=/data/state
VOLUME ["/data"]
USER 10001:10001
WORKDIR /data
EXPOSE 4096
ENTRYPOINT ["node", "/opt/vector/entry.mjs"]
