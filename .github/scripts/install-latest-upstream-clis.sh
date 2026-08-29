#!/usr/bin/env bash

set -euo pipefail
umask 077

max_attempts="${CLAUDE_WORKFLOW_UPSTREAM_INSTALL_ATTEMPTS:-5}"
base_delay_seconds="${CLAUDE_WORKFLOW_UPSTREAM_RETRY_DELAY_SECONDS:-30}"

[[ "${max_attempts}" =~ ^[1-9][0-9]*$ ]] || {
  echo "latest-upstream: install attempts must be a positive integer" >&2
  exit 1
}
[[ "${base_delay_seconds}" =~ ^[0-9]+$ ]] || {
  echo "latest-upstream: retry delay must be a non-negative integer" >&2
  exit 1
}

claude_version="$(npm view @anthropic-ai/claude-code@latest version --prefer-online)"
codex_version="$(npm view @openai/codex@latest version --prefer-online)"
[[ "${claude_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || {
  echo "latest-upstream: invalid Claude Code version: ${claude_version}" >&2
  exit 1
}
[[ "${codex_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || {
  echo "latest-upstream: invalid Codex CLI version: ${codex_version}" >&2
  exit 1
}

echo "latest-upstream: resolved Claude Code ${claude_version} and Codex CLI ${codex_version}"
npm_global_prefix="$(npm prefix --global)"
[[ "${npm_global_prefix}" == /* ]] || {
  echo "latest-upstream: npm global prefix is not absolute: ${npm_global_prefix}" >&2
  exit 1
}
npm_global_prefix="${npm_global_prefix%/}"

assert_global_npm_package() {
  local package_name="$1"
  local package_version="$2"
  local command_name="$3"
  local actual_command
  local expected_command="${npm_global_prefix}/bin/${command_name}"

  npm list --global --depth=0 "${package_name}@${package_version}" >/dev/null 2>&1 || {
    echo "latest-upstream: npm did not install ${package_name}@${package_version}" >&2
    return 1
  }
  actual_command="$(command -v "${command_name}" 2>/dev/null || true)"
  [[ "${actual_command}" == "${expected_command}" ]] || {
    echo "latest-upstream: ${command_name} resolved outside npm's global prefix: ${actual_command:-missing}" >&2
    return 1
  }
}

npm install --global --no-audit --no-fund --prefer-online \
  "@anthropic-ai/claude-code@${claude_version}"
assert_global_npm_package @anthropic-ai/claude-code "${claude_version}" claude
claude_output="$(claude --version)"
claude_reported_version="${claude_output%% *}"
[[ "${claude_reported_version}" == "${claude_version}" ]] || {
  echo "latest-upstream: Claude Code reported an unexpected version: ${claude_output}" >&2
  exit 1
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/claude-workflow-upstream.XXXXXX")"
cleanup() {
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  cache_directory="${temporary_root}/npm-cache-${attempt}"
  npm uninstall --global --no-audit --no-fund @openai/codex >/dev/null 2>&1 || true

  if npm install --global --no-audit --no-fund --include=optional --prefer-online \
    --cache "${cache_directory}" "@openai/codex@${codex_version}" && \
    assert_global_npm_package @openai/codex "${codex_version}" codex; then
    codex_output="$(codex --version 2>&1)" || true
    if [[ "${codex_output}" == "codex-cli ${codex_version}" ]]; then
      echo "${claude_output}"
      echo "${codex_output}"
      exit 0
    fi
    echo "latest-upstream: Codex CLI verification failed: ${codex_output:-no output}" >&2
  fi

  if ((attempt == max_attempts)); then
    echo "latest-upstream: Codex CLI ${codex_version} remained unavailable after ${max_attempts} attempts" >&2
    exit 1
  fi

  delay_seconds=$((attempt * base_delay_seconds))
  echo "latest-upstream: retrying Codex CLI ${codex_version} in ${delay_seconds}s" >&2
  sleep "${delay_seconds}"
done
