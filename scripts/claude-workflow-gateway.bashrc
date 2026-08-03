# Cleanup-only transition hook for historical claude-workflow shell routing.
#
# This file never starts a gateway and never sources gateway settings. It only
# restores values owned by managed historical overlays and clears one bounded
# markerless signature used by older releases. Bare `claude` remains native.
case $- in
  *x*) _CLAUDE_WORKFLOW_GATEWAY_HOOK_XTRACE=1; set +x ;;
  *) _CLAUDE_WORKFLOW_GATEWAY_HOOK_XTRACE=0 ;;
esac
if [ -n "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES-}" ]; then
  _CLAUDE_WORKFLOW_GATEWAY_HAD_MANAGED_OVERLAY=1
else
  _CLAUDE_WORKFLOW_GATEWAY_HAD_MANAGED_OVERLAY=0
fi
_claude_workflow_gateway_restore_environment() {
  case $- in
    *x*) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE=1; set +x ;;
    *) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE=0 ;;
  esac
  case $- in
    *a*) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT=1; set +a ;;
    *) _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT=0 ;;
  esac
  _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES="${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES-}"
  _CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES="${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES-}"
  _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES="${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES-}"
  _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES="${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES-}"
  while [ -n "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES" ]; do
    case "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES" in
      *" "*)
        _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME="${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES%% *}"
        _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES="${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES#* }"
        ;;
      *)
        _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME="$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES"
        _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES=''
        ;;
    esac
    case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" in
      ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;
    esac
    _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME="CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}"
    _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME="CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}"
    eval "_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET=\${${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}+x}"
    _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=0
    case " $_CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES " in
      *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)
        eval "_CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE=\${${_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME}-}"
        eval "_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE=\${${_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME}-}"
        if [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET" = x ] &&
          [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE" = "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE" ]; then
          if _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION="$(typeset -p "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null)"; then
            case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION" in
              export\ *) _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1 ;;
              declare\ *|typeset\ *)
                _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION#* }"
                _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES="${_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES%% *}"
                case "$_CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES" in -*x*) _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1 ;; esac
                ;;
            esac
          else
            # Shells without typeset cannot distinguish the export attribute.
            _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1
          fi
          unset _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION 2>/dev/null || :
          unset _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES 2>/dev/null || :
        fi
        ;;
      *)
        if [ "$_CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET" != x ]; then
          _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED=1
        fi
        ;;
    esac
    if [ "$_CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED" = 1 ]; then
      case " $_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES " in
        *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)
          eval "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET=\${${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME}+x}"
          if [ "$_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET" = x ]; then
            eval "_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE=\${${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME}-}"
            case " $_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES " in
              *" $_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME "*)
                eval 'export '"$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME"'="${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE}"' 2>/dev/null || :
                ;;
              *)
                if [ -n "${BASH_VERSION-}" ]; then
                  export -n "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :
                elif [ -n "${ZSH_VERSION-}" ]; then
                  typeset -g +x "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :
                else
                  unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :
                fi
                eval "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME=\${_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE}" 2>/dev/null || :
                ;;
            esac
          else
            unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || :
          fi
          ;;
        *) unset "$_CLAUDE_WORKFLOW_GATEWAY_ENV_NAME" 2>/dev/null || : ;;
      esac
    fi
    unset "$_CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME" 2>/dev/null || :
    unset "$_CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME" 2>/dev/null || :
  done
  unset CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES 2>/dev/null || :
  unset CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES 2>/dev/null || :
  unset CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES 2>/dev/null || :
  unset CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_NAMES _CLAUDE_WORKFLOW_GATEWAY_MANAGED_SET_NAMES 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_SET_NAMES _CLAUDE_WORKFLOW_GATEWAY_ENV_NAME 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_EXPORTED_NAMES 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_NAME _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_NAME 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_CURRENT_SET _CLAUDE_WORKFLOW_GATEWAY_CURRENT_VALUE 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_DECLARATION 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_ATTRIBUTES 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_SET 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_VALUE_OWNED 2>/dev/null || :
  if [ "$_CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT" = 1 ]; then set -a; fi
  unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_ALLEXPORT 2>/dev/null || :
  if [ "$_CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE" = 1 ]; then
    unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE 2>/dev/null || :
    set -x
  else
    unset _CLAUDE_WORKFLOW_GATEWAY_RESTORE_XTRACE 2>/dev/null || :
  fi
  return 0
}
_claude_workflow_gateway_restore_environment || :
unset -f _claude_workflow_gateway_restore_environment 2>/dev/null || :

_claude_workflow_gateway_cleanup_markerless_environment() {
  case $- in
    *x*) _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE=1; set +x ;;
    *) _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE=0 ;;
  esac
  _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE=0
  if [ "${ANTHROPIC_BASE_URL-}" = http://127.0.0.1:4318 ] && {
    [ "${CLAUDE_CODE_SUBAGENT_MODEL-}" = codex-terra ] ||
      [ "${ANTHROPIC_DEFAULT_SONNET_MODEL-}" = codex-terra ] ||
      [ "${ANTHROPIC_DEFAULT_HAIKU_MODEL-}" = codex-terra ] ||
      [ "${ANTHROPIC_DEFAULT_OPUS_MODEL-}" = codex-terra ]
  }; then
    _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE=1
  fi
  if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE" = 1 ]; then
    unset ANTHROPIC_BASE_URL 2>/dev/null || :
    for _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME in CLAUDE_CODE_SUBAGENT_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL; do
      eval "_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE=\${${_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME}-}"
      if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE" = codex-terra ]; then
        unset "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME" 2>/dev/null || :
      fi
    done
    case "${ANTHROPIC_MODEL-}" in
      codex|'claude-fable-5[1m]') unset ANTHROPIC_MODEL 2>/dev/null || : ;;
    esac
    if [ "${ANTHROPIC_DEFAULT_FABLE_MODEL-}" = 'claude-fable-5[1m]' ]; then
      unset ANTHROPIC_DEFAULT_FABLE_MODEL 2>/dev/null || :
    fi
    if [ "${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY-}" = 0 ]; then
      unset CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 2>/dev/null || :
    fi
  fi
  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_SIGNATURE 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_NAME 2>/dev/null || :
  unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_VALUE 2>/dev/null || :
  if [ "$_CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE" = 1 ]; then
    unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE 2>/dev/null || :
    set -x
  else
    unset _CLAUDE_WORKFLOW_GATEWAY_MARKERLESS_XTRACE 2>/dev/null || :
  fi
  return 0
}
if [ "${_CLAUDE_WORKFLOW_GATEWAY_HAD_MANAGED_OVERLAY:-0}" != 1 ]; then
  _claude_workflow_gateway_cleanup_markerless_environment || :
fi
unset -f _claude_workflow_gateway_cleanup_markerless_environment 2>/dev/null || :
unset _CLAUDE_WORKFLOW_GATEWAY_HAD_MANAGED_OVERLAY 2>/dev/null || :

if [ -n "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN:-}" ]; then
  if [ "${ANTHROPIC_AUTH_TOKEN-}" = "$CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN" ]; then
    unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || :
  fi
  if [ "${ANTHROPIC_API_KEY-}" = "$CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN" ]; then
    unset ANTHROPIC_API_KEY 2>/dev/null || :
  fi
fi
unset CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN 2>/dev/null || :

if [ -n "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE:-}" ]; then
  if [ "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-}" = "$CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE" ]; then
    if [ "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET-}" = '1' ]; then
      export CLAUDE_CODE_DISABLE_TERMINAL_TITLE="${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE-}" 2>/dev/null || :
    else
      unset CLAUDE_CODE_DISABLE_TERMINAL_TITLE 2>/dev/null || :
    fi
  fi
fi
unset CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE 2>/dev/null || :
unset CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE 2>/dev/null || :
unset CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET 2>/dev/null || :

if [ "$_CLAUDE_WORKFLOW_GATEWAY_HOOK_XTRACE" = 1 ]; then
  unset _CLAUDE_WORKFLOW_GATEWAY_HOOK_XTRACE 2>/dev/null || :
  set -x
else
  unset _CLAUDE_WORKFLOW_GATEWAY_HOOK_XTRACE 2>/dev/null || :
fi

:
