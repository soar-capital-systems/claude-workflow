#!/usr/bin/env bash

set -euo pipefail
umask 077

fail() {
  echo "wsl-smoke: $*" >&2
  exit 1
}

for command_name in bash findmnt node npm; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing required command: ${command_name}"
done

kernel_release="$(cat /proc/sys/kernel/osrelease 2>/dev/null || uname -r)"
[[ "${kernel_release}" =~ [Mm]icrosoft-standard-WSL2 ]] ||
  fail "this smoke contract must run inside WSL 2 (kernel: ${kernel_release})"

filesystem_type="$(findmnt --noheadings --output FSTYPE --target "${PWD}" | head -n 1 | tr -d '[:space:]')"
[[ "${filesystem_type}" == "ext4" ]] ||
  fail "checkout must be copied to the WSL-native ext4 filesystem (found: ${filesystem_type:-unknown})"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${node_major}" =~ ^[0-9]+$ ]] || fail "could not determine the Node.js major version"
(( node_major >= 20 )) || fail "Node.js 20 or newer is required (found: $(node --version))"

npm_path="$(command -v npm)"
node scripts/validate-local-install.mjs "${PWD}" "${npm_path}"

negative_probe="$(mktemp)"
cleanup() {
  rm -f -- "${negative_probe}"
}
trap cleanup EXIT
if node scripts/validate-local-install.mjs \
  /mnt/c/claude-workflow-wsl-negative-probe "${npm_path}" >"${negative_probe}" 2>&1; then
  fail "Windows-mounted project storage was not rejected"
fi
grep -q 'refusing to mutate a WSL install on Windows-mounted storage' "${negative_probe}" ||
  fail "Windows-mounted rejection did not produce the expected diagnostic"

npm ci --no-audit --no-fund
npm run -s check
node --test test/local-install.test.js test/onboarding.test.js
node --test \
  test/managed-state-ownership.test.js \
  test/security-hardening.test.js \
  test/shell-migration.test.js
node test/daemon-observability.test.js

package_name="$(node -p 'require("./package.json").name')"
if [[ "${package_name}" == "@onetool/claude-workflow" ]]; then
  npm run -s test:package
else
  node test/package-smoke.test.js
fi

echo "WSL 2 native-filesystem smoke contract passed."
