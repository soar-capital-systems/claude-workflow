export PRESERVED_BEFORE=current
# >>> claude-workflow gateway >>>
claude-workflow-gateway ensure >/dev/null 2>&1
. "${CLAUDE_WORKFLOW_GATEWAY_ENV_FILE}"
# <<< claude-workflow gateway <<<
export PRESERVED_AFTER=current
return 0 2>/dev/null || :
export SHOULD_NOT_MOVE_CLEANUP_BEFORE_RETURN=1
