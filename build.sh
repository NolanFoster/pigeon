#!/bin/sh
set -e

# Install Rust if not available
if ! command -v cargo > /dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  . "$HOME/.cargo/env"
fi

# Add wasm target
rustup target add wasm32-unknown-unknown

# Install worker-build. Pinned because newer worker-build releases require
# wasm-bindgen >= 0.2.121, but worker 0.8 / js-sys 0.3.95 (transitively pinned
# in Cargo.lock) hold wasm-bindgen at 0.2.118.
cargo install worker-build --version 0.8.2 --locked

# Build the worker
worker-build --release
