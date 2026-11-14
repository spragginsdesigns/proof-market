# Job runner image: one fresh container per job is started from this image.
# Everything a README step usually needs is installed at build time, pinned and checksum-verified,
# so a job only needs the network for project dependencies (through the egress allowlist proxy).
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.4
ARG NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG CARGO_NEAR_VERSION=0.23.0
ARG NEAR_CLI_VERSION=0.31.1

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils build-essential pkg-config libssl-dev libudev-dev \
      python3 python3-venv jq procps less file unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js (official binary, checksum from nodejs.org SHASUMS256.txt)
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz && node --version && npm --version

# Rust (rustup-init checksum from static.rust-lang.org); toolchains live in /opt and are read-only for the job user
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSLo /tmp/rustup-init https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable \
    && rm /tmp/rustup-init \
    && rustup target add wasm32-unknown-unknown \
    && rustup toolchain install 1.95.0 --profile minimal --component rustfmt,clippy --target wasm32-unknown-unknown \
    && rustup component add rustfmt clippy \
    && rustc --version && cargo --version

# cargo-near and near CLI (official release binaries, checksums from their release assets)
RUN set -e; cd /tmp; \
    for spec in "near/cargo-near cargo-near-v${CARGO_NEAR_VERSION} cargo-near" "near/near-cli-rs v${NEAR_CLI_VERSION} near-cli-rs"; do \
      set -- $spec; base="https://github.com/$1/releases/download/$2/$3-x86_64-unknown-linux-gnu.tar.gz"; \
      curl -fsSLo pkg.tgz "$base"; curl -fsSLo pkg.sha "$base.sha256"; \
      echo "$(cut -d' ' -f1 pkg.sha)  pkg.tgz" | sha256sum -c -; \
      mkdir -p x && tar -xzf pkg.tgz -C x && find x -type f -perm -u+x -exec install -m 0755 {} /usr/local/bin/ \; ; \
      rm -rf x pkg.tgz pkg.sha; \
    done; cargo-near --version; near --version

# The job user: no password, no sudo, no capabilities (the container also runs with --cap-drop ALL)
RUN useradd --uid 10001 --create-home --home-dir /home/runner --shell /bin/bash runner \
    && chmod -R a+rX /opt/rustup /opt/cargo
USER 10001:10001
WORKDIR /work
CMD ["sleep", "infinity"]
