#!/bin/sh
set -e

# Install Rust if not available
if ! command -v cargo > /dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  . "$HOME/.cargo/env"
fi

# Add wasm target
rustup target add wasm32-unknown-unknown

# Install worker-build
cargo install worker-build

# Build the worker
worker-build --release
