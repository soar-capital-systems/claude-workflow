export PRESERVED_BEFORE=ultrathink
# >>> ultrathink claude-workflow gateway >>>
claude-workflow-gateway ensure >/dev/null 2>&1
. "${CLAUDE_WORKFLOW_GATEWAY_ENV_FILE}"
# <<< ultrathink claude-workflow gateway <<<
export PRESERVED_AFTER=ultrathink
