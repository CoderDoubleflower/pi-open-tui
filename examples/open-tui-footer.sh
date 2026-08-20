#!/bin/bash

set -u

# open-tui Footer script protocol v1: one JSON object is provided on stdin.
input=$(cat)

if ! jq -e '.version == 1' >/dev/null 2>&1 <<<"$input"; then
    printf 'open-tui-footer: unsupported or invalid input\n' >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# open-tui Footer JSON v1 variable reference
#
# Uncomment any assignment you want to use. These cover every field currently
# provided by the plugin. If you enable many of them, consider adding the fields
# to the single mapfile/jq call below to avoid starting jq once per variable.
# -----------------------------------------------------------------------------

# Protocol / terminal / time
# PROTOCOL_VERSION=$(jq -r '.version' <<<"$input")
# TERMINAL_WIDTH=$(jq -r '.terminal.width // 0' <<<"$input")
# NOW_MS=$(jq -r '.time.nowMs // 0' <<<"$input")
# NOW_ISO=$(jq -r '.time.nowIso // empty' <<<"$input")

# Session
# SESSION_CWD=$(jq -r '.session.cwd // empty' <<<"$input")
# SESSION_NAME=$(jq -r '.session.name // empty' <<<"$input")
# SESSION_STARTED_AT_MS=$(jq -r '.session.startedAtMs // 0' <<<"$input")

# Model
# MODEL_ID=$(jq -r '.model.id // empty' <<<"$input")
# MODEL_NAME=$(jq -r '.model.name // empty' <<<"$input")
# MODEL_PROVIDER=$(jq -r '.model.provider // empty' <<<"$input")
# MODEL_REASONING=$(jq -r '.model.reasoning // false' <<<"$input")
# MODEL_THINKING_LEVEL=$(jq -r '.model.thinkingLevel // empty' <<<"$input")
# MODEL_CONTEXT_WINDOW=$(jq -r '.model.contextWindow // 0' <<<"$input")

# Current context usage
# CONTEXT_TOKENS=$(jq -r '.context.tokens // 0' <<<"$input")
# CONTEXT_WINDOW=$(jq -r '.context.contextWindow // 0' <<<"$input")
# CONTEXT_PERCENT=$(jq -r '.context.percent // 0' <<<"$input")

# Cumulative usage and cost
# USAGE_INPUT=$(jq -r '.usage.input // 0' <<<"$input")
# USAGE_OUTPUT=$(jq -r '.usage.output // 0' <<<"$input")
# USAGE_CACHE_READ=$(jq -r '.usage.cacheRead // 0' <<<"$input")
# USAGE_CACHE_WRITE=$(jq -r '.usage.cacheWrite // 0' <<<"$input")
# USAGE_COST=$(jq -r '.usage.cost // 0' <<<"$input")
# USAGE_LATEST_CACHE_HIT_RATE=$(jq -r '.usage.latestCacheHitRate // 0' <<<"$input")

# Git branch, working tree, remote state, and detached commit
# GIT_BRANCH=$(jq -r '.git.branch // empty' <<<"$input")
# GIT_AHEAD=$(jq -r '.git.ahead // 0' <<<"$input")
# GIT_BEHIND=$(jq -r '.git.behind // 0' <<<"$input")
# GIT_MODIFIED=$(jq -r '.git.modified // 0' <<<"$input")
# GIT_UNTRACKED=$(jq -r '.git.untracked // 0' <<<"$input")
# GIT_STAGED=$(jq -r '.git.staged // 0' <<<"$input")
# GIT_STASHED=$(jq -r '.git.stashed // 0' <<<"$input")
# GIT_CONFLICTED=$(jq -r '.git.conflicted // 0' <<<"$input")
# GIT_RENAMED=$(jq -r '.git.renamed // 0' <<<"$input")
# GIT_DELETED=$(jq -r '.git.deleted // 0' <<<"$input")
# GIT_COMMIT_OID=$(jq -r '.git.commit.oid // empty' <<<"$input")
# GIT_COMMIT_DETACHED=$(jq -r '.git.commit.detached // false' <<<"$input")
# GIT_COMMIT_TAG=$(jq -r '.git.commit.tag // empty' <<<"$input")

# Detected project runtime
# RUNTIME_NAME=$(jq -r '.runtime.name // empty' <<<"$input")
# RUNTIME_VERSION=$(jq -r '.runtime.version // empty' <<<"$input")

# Agent timer; all duration/timestamp values are milliseconds
# TIMER_WORKING=$(jq -r '.timer.working // false' <<<"$input")
# TIMER_WORKING_SINCE_MS=$(jq -r '.timer.workingSinceMs // empty' <<<"$input")
# TIMER_WORKING_ELAPSED_MS=$(jq -r '.timer.workingElapsedMs // empty' <<<"$input")
# TIMER_LAST_DONE_IN_MS=$(jq -r '.timer.lastDoneInMs // empty' <<<"$input")

# Extension status values. The JSON object is sorted by extension id.
# EXTENSION_STATUSES_JSON=$(jq -c '.extensionStatuses // {}' <<<"$input")
# EXTENSION_STATUSES_TEXT=$(jq -r '(.extensionStatuses // {}) | to_entries | map(.value) | join(" | ")' <<<"$input")

# -----------------------------------------------------------------------------
# Optional color definitions
# -----------------------------------------------------------------------------

RESET='\033[0m'
BLUE='\033[1;34m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[1;35m'
CYAN='\033[1;36m'
# RED='\033[1;31m'
# WHITE='\033[1;37m'
# GRAY='\033[90m'
# DIM='\033[2m'
# RGB_EXAMPLE='\033[38;2;181;181;181m'

mapfile -t fields < <(
    jq -r '[
        (.model.name // .model.id // "no-model"),
        (.session.cwd // ""),
        (.model.thinkingLevel // ""),
        (((.context.tokens // 0) / 1000) | round | tostring),
        (((.context.contextWindow // .model.contextWindow // 0) / 1000) | round | tostring),
        (if .usage.latestCacheHitRate == null then "" else (.usage.latestCacheHitRate | tostring) end),
        ((.extensionStatuses // {}) | to_entries | map(.value) | join(" | "))
    ] | .[]' <<<"$input"
)

MODEL=${fields[0]:-no-model}
DIR=${fields[1]:-}
EFFORT=${fields[2]:-}
CURRENT_TOKENS_K=${fields[3]:-0}
CONTEXT_SIZE_K=${fields[4]:-0}
CACHE_HIT_RATE=${fields[5]:-}
EXTENSION_STATUSES=${fields[6]:-}

trimmed_dir=${DIR%/}
DIR_NAME=${trimmed_dir##*/}
if [[ -z "$DIR_NAME" ]]; then
    DIR_NAME=${DIR:-/}
fi

EFFORT_SEGMENT=""
if [[ -n "$EFFORT" ]]; then
    EFFORT_SEGMENT=" | ${YELLOW}Effort: ${EFFORT}${RESET}"
fi

CACHE_HIT_SEGMENT=""
if [[ "$CACHE_HIT_RATE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf -v CACHE_HIT_SEGMENT ' | %bCache hit: %.1f%%%b' "$YELLOW" "$CACHE_HIT_RATE" "$RESET"
fi

# -----------------------------------------------------------------------------
# Optional ready-to-use output segments
#
# Uncomment both the required variable assignments above and the segment code
# you need, then append the segment variable to the final printf line.
# -----------------------------------------------------------------------------

# Provider
# PROVIDER_SEGMENT=""
# if [[ -n "$MODEL_PROVIDER" ]]; then
#     PROVIDER_SEGMENT=" | ${CYAN}Provider: ${MODEL_PROVIDER}${RESET}"
# fi

# Session name
# SESSION_SEGMENT=""
# if [[ -n "$SESSION_NAME" ]]; then
#     SESSION_SEGMENT=" | ${BLUE}Session: ${SESSION_NAME}${RESET}"
# fi

# Git branch and common status counters
# GIT_SEGMENT=""
# if [[ -n "$GIT_BRANCH" ]]; then
#     GIT_SEGMENT=" | ${MAGENTA}Git: ${GIT_BRANCH}${RESET}"
#     [[ "$GIT_MODIFIED" -gt 0 ]] && GIT_SEGMENT+=" ${YELLOW}M:${GIT_MODIFIED}${RESET}"
#     [[ "$GIT_UNTRACKED" -gt 0 ]] && GIT_SEGMENT+=" ${GRAY}?:${GIT_UNTRACKED}${RESET}"
#     [[ "$GIT_STAGED" -gt 0 ]] && GIT_SEGMENT+=" ${GREEN}S:${GIT_STAGED}${RESET}"
#     [[ "$GIT_CONFLICTED" -gt 0 ]] && GIT_SEGMENT+=" ${RED}C:${GIT_CONFLICTED}${RESET}"
# fi

# Runtime
# RUNTIME_SEGMENT=""
# if [[ -n "$RUNTIME_NAME" ]]; then
#     RUNTIME_SEGMENT=" | ${GREEN}${RUNTIME_NAME}${RESET}"
#     [[ -n "$RUNTIME_VERSION" ]] && RUNTIME_SEGMENT+=" ${RUNTIME_VERSION}"
# fi

# Input/output/cache token totals
# USAGE_SEGMENT=" | ${BLUE}In: ${USAGE_INPUT}${RESET} ${GREEN}Out: ${USAGE_OUTPUT}${RESET} ${CYAN}Cache: ${USAGE_CACHE_READ}${RESET}"

# Session cost
# COST_SEGMENT=$(printf ' | %bCost: $%.3f%b' "$YELLOW" "$USAGE_COST" "$RESET")

# Context percentage
# CONTEXT_PERCENT_SEGMENT=$(printf ' | %bContext: %.1f%%%b' "$MAGENTA" "$CONTEXT_PERCENT" "$RESET")

# Working/done timer
# TIMER_SEGMENT=""
# if [[ "$TIMER_WORKING" == "true" && -n "$TIMER_WORKING_ELAPSED_MS" ]]; then
#     TIMER_SEGMENT=" | ${YELLOW}Working: $((TIMER_WORKING_ELAPSED_MS / 1000))s${RESET}"
# elif [[ -n "$TIMER_LAST_DONE_IN_MS" ]]; then
#     TIMER_SEGMENT=" | ${GREEN}Done: $((TIMER_LAST_DONE_IN_MS / 1000))s${RESET}"
# fi

# Extension statuses
# EXTENSIONS_SEGMENT=""
# if [[ -n "$EXTENSION_STATUSES_TEXT" ]]; then
#     EXTENSIONS_SEGMENT=" | ${CYAN}${EXTENSION_STATUSES_TEXT}${RESET}"
# fi

# Example final composition with optional segments:
# printf '%b\n' "${BLUE}[${MODEL}]${RESET} | ${GREEN}📁 ${DIR_NAME}${RESET}${EFFORT_SEGMENT}${PROVIDER_SEGMENT}${SESSION_SEGMENT}${GIT_SEGMENT}${RUNTIME_SEGMENT}${USAGE_SEGMENT}${COST_SEGMENT}${TIMER_SEGMENT}${EXTENSIONS_SEGMENT}"

printf '%b\n' "${BLUE}[${MODEL}]${RESET} | ${GREEN}📁 ${DIR_NAME}${RESET}${EFFORT_SEGMENT} | ${MAGENTA}Context: ${CURRENT_TOKENS_K}K${RESET}/${CYAN}${CONTEXT_SIZE_K}K${RESET}${CACHE_HIT_SEGMENT}"

if [[ -n "$EXTENSION_STATUSES" ]]; then
    printf '%b\n' "${CYAN}${EXTENSION_STATUSES}${RESET}"
fi
