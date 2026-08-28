#!/usr/bin/env node

/**
 * Shared claude-workflow gateway daemon.
 *
 * Runs the same workflow-routing gateway the `claude-workflow` launcher
 * spawns per session, but on a fixed localhost port for explicitly configured
 * local clients. It never changes plain Claude Code sessions through shell
 * startup configuration.
 * On listen it publishes the env exports to
 * ${XDG_STATE_HOME:-~/.cache}/claude-workflow/claude-workflow-gateway.env
 * for explicit integrations to consume.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_TERMINAL_TITLE_ENV_NAME,
  MANAGED_GATEWAY_AUTH_ENV_NAME,
  MANAGED_TERMINAL_TITLE_ENV_NAME,
  MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME,
  MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME,
  MANAGED_WORKFLOW_ENV_VALUE_PREFIX,
  PREVIOUS_TERMINAL_TITLE_ENV_NAME,
  PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX,
} from '../utils/child-env.js';
import { createGatewayServer } from '../gateway/server.js';
import { resolveModelRoute } from '../gateway/model-routing.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  envString,
  routeTargetSummary,
} from '../gateway/workflow-config.js';
import {
  MANAGED_ENV_BASENAME,
  claimManagedState,
  validateManagedStatePaths,
  verifyManagedArtifactForReplacement,
} from './claude-workflow-managed-state.js';

const DEFAULT_DAEMON_PORT = 4318;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHELL_LOCAL_PREVIOUS_ENV_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

function log(message) {
  process.stderr.write(`claude-workflow-gateway: ${message}\n`);
}

// The daemon deliberately has its own port variable: ULTRATHINK_GATEWAY_PORT
// belongs to the per-session launcher, and sharing it would make the two
// fight over one port (launcher EADDRINUSE, or the daemon health check
// probing a transient launcher gateway). Keep this default in sync with
// scripts/claude-workflow-daemon.sh.
export function daemonPort() {
  const configured = envString('ULTRATHINK_GATEWAY_DAEMON_PORT');
  if (!configured) {
    return DEFAULT_DAEMON_PORT;
  }

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_DAEMON_PORT must be an integer between 1 and 65535, got ${configured}`
    );
  }

  return parsed;
}

function managedStateConfiguration() {
  const stateHome = envString('XDG_STATE_HOME') || path.join(os.homedir(), '.cache');
  if (!path.isAbsolute(stateHome)) {
    throw new Error('XDG_STATE_HOME must be an absolute path');
  }
  const canonicalStateDirectory = path.join(stateHome, 'claude-workflow');
  const legacyStateDirectory = path.join(os.homedir(), '.cache', 'ultrathink');
  let stateDirectory = envString('CLAUDE_WORKFLOW_GATEWAY_STATE_DIR');
  if (!stateDirectory) {
    const legacyHasPriorState =
      !fs.existsSync(canonicalStateDirectory) &&
      (fs.existsSync(path.join(legacyStateDirectory, 'claude-workflow-gateway.pid')) ||
        fs.existsSync(path.join(legacyStateDirectory, MANAGED_ENV_BASENAME)) ||
        fs.existsSync(path.join(legacyStateDirectory, '.claude-workflow-gateway.owner')));
    stateDirectory = legacyHasPriorState ? legacyStateDirectory : canonicalStateDirectory;
  }

  const configuredTarget = envString('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  const environmentFile =
    configuredTarget || path.join(stateDirectory, MANAGED_ENV_BASENAME);
  validateManagedStatePaths(stateDirectory, environmentFile);
  const kind =
    stateDirectory === canonicalStateDirectory
      ? 'canonical'
      : stateDirectory === legacyStateDirectory
        ? 'legacy'
        : 'custom';
  return { environmentFile, kind, stateDirectory };
}

export function quotePosixShellValue(value) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error('workflow environment values must not contain NUL bytes');
  }

  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function managedWorkflowEnvironmentCleanupShell() {
  return [
    '_claude_workflow_gateway_restore_environment() {',
    '  case $- in',
    '    *x*) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE=1; set +x ;;',
    '    *) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE=0 ;;',
    '  esac',
    '  case $- in',
    '    *a*) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT=1; set +a ;;',
    '    *) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT=0 ;;',
    '  esac',
    `  _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES="\${${MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME}-}"`,
    `  _CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES="\${${MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME}-}"`,
    `  _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES="\${${PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME}-}"`,
    `  _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES="\${${PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME}-}"`,
    '  while [ -n "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES" ]; do',
    '    case "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES" in',
    '      *" "*)',
    '        _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME="${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES%% *}"',
    '        _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES="${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES#* }"',
    '        ;;',
    '      *)',
    '        _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME="$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES"',
    "        _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES=''",
    '        ;;',
    '    esac',
    '    case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" in',
    "      ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;",
    '    esac',
    `    _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME="${MANAGED_WORKFLOW_ENV_VALUE_PREFIX}\${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}"`,
    `    _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME="${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}\${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}"`,
    '    eval "_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET=\\${${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}+x}"',
    '    _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=0',
    '    case " $_CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES " in',
    '      *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)',
    '        eval "_CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE=\\${${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}-}"',
    '        eval "_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE=\\${${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME}-}"',
    '        if [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET" = x ] &&',
    '          [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE" = "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE" ]; then',
    '          if _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION="$(typeset -p "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null)"; then',
    '            case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION" in',
    '              export\\ *) _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1 ;;',
    '              declare\\ *|typeset\\ *)',
    '                _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION#* }"',
    '                _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES%% *}"',
    '                case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES" in -*x*) _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1 ;; esac',
    '                ;;',
    '            esac',
    '          else',
    '            # Shells without typeset cannot distinguish the export attribute.',
    '            _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1',
    '          fi',
    '          unset _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION 2>/dev/null || :',
    '          unset _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES 2>/dev/null || :',
    '        fi',
    '        ;;',
    '      *)',
    '        if [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET" != x ]; then',
    '          _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1',
    '        fi',
    '        ;;',
    '    esac',
    '    if [ "$_CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED" = 1 ]; then',
    '      case " $_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES " in',
    '        *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)',
    '          eval "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET=\\${${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME}+x}"',
    '          if [ "$_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET" = x ]; then',
    '            eval "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE=\\${${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME}-}"',
    '            case " $_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES " in',
    '              *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)',
    '                eval \'export \'"$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME"\'=\"${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE}\"\' 2>/dev/null || :',
    '                ;;',
    '              *)',
    '                if [ -n "${BASH_VERSION-}" ]; then',
    '                  export -n "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :',
    '                elif [ -n "${ZSH_VERSION-}" ]; then',
    '                  typeset -g +x "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :',
    '                else',
    '                  unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :',
    '                fi',
    '                eval "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME=\\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE}" 2>/dev/null || :',
    '                ;;',
    '            esac',
    '          else',
    '            unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :',
    '          fi',
    '          ;;',
    '        *) unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || : ;;',
    '      esac',
    '    fi',
    '    unset "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME" 2>/dev/null || :',
    '    unset "$_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME" 2>/dev/null || :',
    '  done',
    `  unset ${MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME} 2>/dev/null || :`,
    `  unset ${MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME} 2>/dev/null || :`,
    `  unset ${PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME} 2>/dev/null || :`,
    `  unset ${PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME} 2>/dev/null || :`,
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES _CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET _CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED 2>/dev/null || :',
    '  if [ "$_CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT" = 1 ]; then set -a; fi',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT 2>/dev/null || :',
    '  if [ "$_CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE" = 1 ]; then',
    '    unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE 2>/dev/null || :',
    '    set -x',
    '  else',
    '    unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE 2>/dev/null || :',
    '  fi',
    '  return 0',
    '}',
    '_claude_workflow_gateway_restore_environment || :',
    'unset -f _claude_workflow_gateway_restore_environment 2>/dev/null || :',
  ].join('\n');
}

export function markerlessWorkflowEnvironmentCleanupShell() {
  return [
    '_claude_workflow_gateway_cleanup_markerless_environment() {',
    '  case $- in',
    '    *x*) _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE=1; set +x ;;',
    '    *) _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE=0 ;;',
    '  esac',
    '  _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE=0',
    '  if [ "${ANTHROPIC_BASE_URL-}" = http://127.0.0.1:4318 ] && {',
    '    [ "${CLAUDE_CODE_SUBAGENT_MODEL-}" = codex-terra ] ||',
    '      [ "${ANTHROPIC_DEFAULT_SONNET_MODEL-}" = codex-terra ] ||',
    '      [ "${ANTHROPIC_DEFAULT_HAIKU_MODEL-}" = codex-terra ] ||',
    '      [ "${ANTHROPIC_DEFAULT_OPUS_MODEL-}" = codex-terra ]',
    '  }; then',
    '    _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE=1',
    '  fi',
    '  if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE" = 1 ]; then',
    '    unset ANTHROPIC_BASE_URL 2>/dev/null || :',
    '    for _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME in CLAUDE_CODE_SUBAGENT_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL; do',
    '      eval "_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE=\\${${_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME}-}"',
    '      if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE" = codex-terra ]; then',
    '        unset "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME" 2>/dev/null || :',
    '      fi',
    '    done',
    '    case "${ANTHROPIC_MODEL-}" in',
    '      codex|\'claude-fable-5[1m]\') unset ANTHROPIC_MODEL 2>/dev/null || : ;;',
    '    esac',
    '    if [ "${ANTHROPIC_DEFAULT_FABLE_MODEL-}" = \'claude-fable-5[1m]\' ]; then',
    '      unset ANTHROPIC_DEFAULT_FABLE_MODEL 2>/dev/null || :',
    '    fi',
    '    if [ "${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY-}" = 0 ]; then',
    '      unset CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 2>/dev/null || :',
    '    fi',
    '  fi',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME 2>/dev/null || :',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE 2>/dev/null || :',
    '  if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE" = 1 ]; then',
    '    unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE 2>/dev/null || :',
    '    set -x',
    '  else',
    '    unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE 2>/dev/null || :',
    '  fi',
    '  return 0',
    '}',
    'if [ "${_CLAUDE_WORKFLOW_GATEWAY_HAD_MANAGED_OVERLAY:-0}" != 1 ]; then',
    '  _claude_workflow_gateway_cleanup_markerless_environment || :',
    'fi',
    'unset -f _claude_workflow_gateway_cleanup_markerless_environment 2>/dev/null || :',
  ].join('\n');
}

export function serializeWorkflowEnvironment(clientEnv) {
  const xtraceGuard = [
    'case $- in',
    '  *x*) _CLAUDE_WORKFLOW_GATEWAY_SERIALIZE_XTRACE=1; set +x ;;',
    '  *) _CLAUDE_WORKFLOW_GATEWAY_SERIALIZE_XTRACE=0 ;;',
    'esac',
  ];
  // Remove only credentials installed by a previous workflow environment.
  // Equality with the marker preserves any real credential the user has set
  // since that environment was sourced.
  const managedAuthCleanup = [
    `if [ -n "\${${MANAGED_GATEWAY_AUTH_ENV_NAME}:-}" ]; then`,
    `  if [ "\${ANTHROPIC_AUTH_TOKEN-}" = "\$${MANAGED_GATEWAY_AUTH_ENV_NAME}" ]; then unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || :; fi`,
    `  if [ "\${ANTHROPIC_API_KEY-}" = "\$${MANAGED_GATEWAY_AUTH_ENV_NAME}" ]; then unset ANTHROPIC_API_KEY 2>/dev/null || :; fi`,
    'fi',
    `unset ${MANAGED_GATEWAY_AUTH_ENV_NAME} 2>/dev/null || :`,
  ];
  // Preserve compatibility with environment files generated before the
  // complete managed-overlay snapshot below was introduced.
  const managedTerminalTitleCleanup = [
    `if [ -n "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}:-}" ]; then`,
    `  if [ "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-}" = "\$${MANAGED_TERMINAL_TITLE_ENV_NAME}" ]; then`,
    `    if [ "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-}" = '1' ]; then`,
    `      export ${CLAUDE_TERMINAL_TITLE_ENV_NAME}="\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-}" 2>/dev/null || :`,
    '    else',
    `      unset ${CLAUDE_TERMINAL_TITLE_ENV_NAME} 2>/dev/null || :`,
    '    fi',
    '  fi',
    'fi',
    `unset ${MANAGED_TERMINAL_TITLE_ENV_NAME} 2>/dev/null || :`,
    `unset ${PREVIOUS_TERMINAL_TITLE_ENV_NAME} 2>/dev/null || :`,
    `unset ${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME} 2>/dev/null || :`,
  ];
  const clientEntries = Object.entries(clientEnv);
  for (const [key] of clientEntries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`invalid workflow environment variable name: ${key}`);
    }
  }

  const managedEntries = clientEntries.filter(
    ([key]) => key !== MANAGED_GATEWAY_AUTH_ENV_NAME
  );
  const managedNames = managedEntries.map(([key]) => key);
  const managedSetNames = managedEntries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => key);
  const snapshotLines = [
    'case $- in',
    '  *a*) _CLAUDE_WORKFLOW_GATEWAY_SNAPSHOT_ALLEXPORT=1; set +a ;;',
    '  *) _CLAUDE_WORKFLOW_GATEWAY_SNAPSHOT_ALLEXPORT=0 ;;',
    'esac',
    "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES=''",
    "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES=''",
  ];
  const applyLines = [];

  for (const [key, value] of managedEntries) {
    const previousValueName = `${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}${key}`;
    const managedValueName = `${MANAGED_WORKFLOW_ENV_VALUE_PREFIX}${key}`;
    snapshotLines.push(
      `unset ${previousValueName} 2>/dev/null || :`,
      `if [ "\${${key}+x}" = 'x' ]; then`,
      `  _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION="$(typeset -p ${key} 2>/dev/null)" || _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION=''`,
      '  _CLAUDE_WORKFLOW_GATEWAY_ENV_WAS_EXPORTED=0',
      '  case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION" in',
      '    export\\ *) _CLAUDE_WORKFLOW_GATEWAY_ENV_WAS_EXPORTED=1 ;;',
      '    declare\\ *|typeset\\ *)',
      '      _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION#* }"',
      '      _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES%% *}"',
      '      case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES" in -*x*) _CLAUDE_WORKFLOW_GATEWAY_ENV_WAS_EXPORTED=1 ;; esac',
      '      ;;',
      '  esac',
      '  if [ "$_CLAUDE_WORKFLOW_GATEWAY_ENV_WAS_EXPORTED" = 1 ]; then',
      `      _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES="\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES} ${key}"`,
      SHELL_LOCAL_PREVIOUS_ENV_NAMES.has(key)
        ? `      ${previousValueName}="\${${key}-}"`
        : `      export ${previousValueName}="\${${key}-}"`,
      '  else',
      `      ${previousValueName}="\${${key}-}"`,
      '  fi',
      '  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION 2>/dev/null || :',
      '  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES 2>/dev/null || :',
      '  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_WAS_EXPORTED 2>/dev/null || :',
      `  _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES="\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES} ${key}"`,
      'else',
      `  unset ${previousValueName} 2>/dev/null || :`,
      'fi'
    );
    if (value === null || value === undefined) {
      applyLines.push(
        `unset ${key} 2>/dev/null || :`,
        `unset ${managedValueName} 2>/dev/null || :`
      );
    } else {
      applyLines.push(
        `export ${key}=${quotePosixShellValue(value)}`,
        `export ${managedValueName}=${quotePosixShellValue(value)}`
      );
    }
  }

  const internalClientEntries = clientEntries.filter(
    ([key]) => key === MANAGED_GATEWAY_AUTH_ENV_NAME
  );
  for (const [key, value] of internalClientEntries) {
    applyLines.push(
      value === null || value === undefined
        ? `unset ${key} 2>/dev/null || :`
        : `export ${key}=${quotePosixShellValue(value)}`
    );
  }

  if (managedNames.length > 0) {
    applyLines.push(
      `export ${MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME}=${quotePosixShellValue(managedNames.join(' '))}`,
      `export ${MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME}=${quotePosixShellValue(managedSetNames.join(' '))}`,
      `export ${PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME}="\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES# }"`,
      `export ${PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME}="\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES# }"`
    );
  } else {
    applyLines.push(
      `unset ${MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME} 2>/dev/null || :`,
      `unset ${MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME} 2>/dev/null || :`,
      `unset ${PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME} 2>/dev/null || :`,
      `unset ${PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME} 2>/dev/null || :`
    );
  }
  applyLines.push(
    'unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES 2>/dev/null || :',
    'unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES 2>/dev/null || :',
    'if [ "$_CLAUDE_WORKFLOW_GATEWAY_SNAPSHOT_ALLEXPORT" = 1 ]; then set -a; fi',
    'unset _CLAUDE_WORKFLOW_GATEWAY_SNAPSHOT_ALLEXPORT 2>/dev/null || :'
  );

  const xtraceRestore = [
    'if [ "$_CLAUDE_WORKFLOW_GATEWAY_SERIALIZE_XTRACE" = 1 ]; then',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_SERIALIZE_XTRACE 2>/dev/null || :',
    '  set -x',
    'else',
    '  unset _CLAUDE_WORKFLOW_GATEWAY_SERIALIZE_XTRACE 2>/dev/null || :',
    'fi',
  ];

  return `${xtraceGuard.join('\n')}\n${managedWorkflowEnvironmentCleanupShell()}\n${managedAuthCleanup.join('\n')}\n${managedTerminalTitleCleanup.join('\n')}\n${snapshotLines.join('\n')}\n${applyLines.join('\n')}\n${xtraceRestore.join('\n')}\n`;
}

export function writeWorkflowEnvironmentFile(
  targetPath,
  clientEnv,
  { stateKind = 'custom' } = {}
) {
  const target = targetPath;
  const directory = path.dirname(target);
  validateManagedStatePaths(directory, target);
  claimManagedState(directory, {
    kind: stateKind,
    allowMigration: stateKind !== 'custom',
  });
  verifyManagedArtifactForReplacement(directory, path.basename(target));

  const tempPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serializeWorkflowEnvironment(clientEnv), 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    const tempStats = fs.fstatSync(descriptor);
    if (!tempStats.isFile() || (tempStats.mode & 0o077) !== 0) {
      throw new Error(
        `workflow environment file does not enforce owner-only permissions: ${tempPath}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, target);
    return target;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}

function writeEnvFile(
  config,
  gatewayBaseUrl,
  subagentModelId,
  mainModelId,
  managedState = managedStateConfiguration()
) {
  const { environmentFile: target, kind } = managedState;
  const clientEnv = buildWorkflowClientEnv(
    config,
    gatewayBaseUrl,
    subagentModelId,
    mainModelId
  );
  return writeWorkflowEnvironmentFile(target, clientEnv, {
    stateKind: kind,
  });
}

async function main() {
  const managedState = managedStateConfiguration();
  if (!Object.hasOwn(process.env, 'ULTRATHINK_GATEWAY_TRACE_DIR')) {
    process.env.ULTRATHINK_GATEWAY_TRACE_DIR = path.join(
      managedState.stateDirectory,
      'gateway-trace'
    );
  }
  const { config, mainModelId, rawSubagentModelId, subagentModelId, subagentRoute } =
    buildWorkflowGatewayConfig({
      port: daemonPort(),
      host: '127.0.0.1',
      dynamicToolsOnly: true,
    });

  resolveModelRoute(mainModelId, config);
  resolveModelRoute(rawSubagentModelId, config);
  if (subagentModelId !== rawSubagentModelId) {
    resolveModelRoute(subagentModelId, config);
  }

  const runtime = createGatewayServer(config);

  runtime.server.on('error', function onServerError(error) {
    if (error?.code === 'EADDRINUSE') {
      log(
        `port ${config.port} is already in use — another daemon instance or service holds it. ` +
          'Check scripts/claude-workflow-daemon.sh status, or set ULTRATHINK_GATEWAY_DAEMON_PORT.'
      );
    } else {
      log(`fatal server error: ${error.stack || error.message}`);
    }
    process.exitCode = 1;
  });

  runtime.server.on('listening', function onListening() {
    const address = runtime.server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const gatewayBaseUrl = `http://${config.host}:${port}`;
    log(`listening at ${gatewayBaseUrl}`);
    log(`main model ${mainModelId}`);
    log(`subagent model ${subagentModelId}`);
    if (subagentModelId !== rawSubagentModelId) {
      log(`subagent route ${rawSubagentModelId} -> ${routeTargetSummary(subagentRoute)}`);
    }

    try {
      const target = writeEnvFile(
        config,
        gatewayBaseUrl,
        subagentModelId,
        mainModelId,
        managedState
      );
      log(`env exports written to ${target}`);
    } catch (error) {
      // The env file is the daemon's contract with shell sessions; serving
      // while it is missing would silently strand every plain session on
      // direct Anthropic. Fail loudly instead.
      log(`could not write env file: ${error.stack || error.message}`);
      void runtime.close().finally(function exitAfterCleanup() {
        process.exit(1);
      });
    }
  });

  async function closeAndExit(signal) {
    log(`received ${signal}, shutting down`);
    try {
      await runtime.close();
    } catch {
      // Best-effort cleanup only.
    }
    process.exit(0);
  }

  process.on('SIGINT', function onSigint() {
    void closeAndExit('SIGINT');
  });
  process.on('SIGTERM', function onSigterm() {
    void closeAndExit('SIGTERM');
  });
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  main().catch(function onError(error) {
    log(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
