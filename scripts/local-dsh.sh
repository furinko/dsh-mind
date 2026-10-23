#!/usr/bin/env bash
# Local profile deployment; machine paths live outside the repository.
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_config="${DSH_MIND_LOCAL_CONFIG:-$HOME/.local/share/dsh-mind/local.env}"
[[ -f "$task_config" ]] || { echo "缺少本机配置：$task_config" >&2; exit 1; }
source "$task_config"
: "${MIND_NODE:?}" "${MIND_GIT:?}" "${MIND_APP_DIR:?}" "${MIND_PROFILE_DIR:?}" "${MIND_RUNTIME_DIR:?}" "${MIND_AUDIT_DIR:?}"
export PATH="$(dirname -- "$MIND_NODE"):$PATH"
if [[ -n "${MIND_GIT_EXEC_PATH:-}" ]]; then export GIT_EXEC_PATH="$MIND_GIT_EXEC_PATH"; fi
cd -- "$task_root"
mkdir -p -- "$MIND_AUDIT_DIR"
chmod 700 -- "$MIND_AUDIT_DIR"

task_git() { "$MIND_GIT" -C "$task_root" "$@"; }
task_runtime_git() { "$MIND_GIT" -C "$MIND_RUNTIME_DIR" "$@"; }
task_clean() {
  local task_status
  if ! task_status="$("$MIND_GIT" -C "$1" status --porcelain)"; then
    echo "无法核对工作区状态，停止部署：$1" >&2
    return 1
  fi
  [[ -z "$task_status" ]] || {
    echo "工作区有未提交修改，请先提交后再部署：$1" >&2; exit 1;
  }
}
task_check() {
  local task_log="$MIND_AUDIT_DIR/check-$(date -u +%Y%m%dT%H%M%S)-$$.log"
  echo "运行 preflight、完整测试、看板断言与安装检查。日志：$task_log"
  if (
    set -e
    "$MIND_NODE" test/preflight.mjs &&
    "$MIND_NODE" --test 'test/*.test.js' 'components/board/test/*.test.js' &&
    "$MIND_NODE" components/board/test/client-harness.mjs &&
    "$MIND_NODE" scripts/verify-profile-install.mjs --selftest &&
    task_git diff --check
  ) >"$task_log" 2>&1; then
    grep -E '^ℹ (tests|pass|fail|skipped)|^client-harness:|^✔ preflight' "$task_log"
    echo "检查通过。"
  else
    tail -n 60 "$task_log" >&2
    return 1
  fi
}
task_layout_compatible() {
  "$MIND_NODE" "$task_root/scripts/check-deployment-layout.mjs" \
    --repo "$task_root" --git "$MIND_GIT" --target "$1" \
    --profile "$MIND_PROFILE_DIR" --runtime "$MIND_RUNTIME_DIR" \
    --home-root "${DSH_HOME:-$HOME/.dsh}" --private-root "${MIND_PRIVATE_ROOT:-}"
}
task_switch_runtime() {
  local task_target="$1" task_previous task_stamp task_evidence
  task_previous="$(task_runtime_git rev-parse HEAD)"
  # Check both directions before stopping a live service or changing recovery refs.
  task_layout_compatible "$task_target" && task_layout_compatible "$task_previous" || return 1
  task_stamp="$(date -u +%Y%m%dT%H%M%S)-$$"
  task_evidence="$MIND_AUDIT_DIR/deploy-$task_stamp"
  mkdir -m 700 -- "$task_evidence"
  cp -- "$MIND_PROFILE_DIR/package.json" "$MIND_PROFILE_DIR/cordis.patch.yml" "$task_evidence/"
  if [[ -f "$MIND_APP_DIR/server.log" ]]; then cp -- "$MIND_APP_DIR/server.log" "$task_evidence/server-before.log"; fi
  task_git update-ref "refs/dsh-local/history/$task_stamp" "$task_previous"
  task_git update-ref refs/dsh-local/previous "$task_previous"
  "$MIND_APP_DIR/stop.sh"
  # Recheck after shutdown and immediately before launch: startup or another
  # offline operation may have changed a storage format since the first check.
  if task_layout_compatible "$task_target" &&
     task_layout_compatible "$task_previous" &&
     task_runtime_git checkout --detach "$task_target" &&
     "$MIND_NODE" "$MIND_RUNTIME_DIR/scripts/verify-profile-install.mjs" "$MIND_PROFILE_DIR" &&
     task_layout_compatible "$task_target" &&
     "$MIND_APP_DIR/launch.sh" --no-open; then
    task_git update-ref refs/dsh-local/current "$task_target"
    "$MIND_NODE" --input-type=module - "$task_evidence/deployment.json" "$task_target" "$task_previous" <<'JS'
import { writeFileSync } from 'node:fs';
const [path, deployed, previous] = process.argv.slice(2);
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), deployed, previous,
  verified: 'source tests, profile install, cold restart and HTTP readiness',
  pending: 'refresh browser; check board, settings and /mind-guard probe' }, null, 2) + '\n', { mode: 0o600 });
JS
    echo "已同步并冷启动 DSH：$task_target"
    echo "回执：$task_evidence/deployment.json"
    echo '请刷新客户端，核对心智看板，并执行 /mind-guard probe。'
  else
    echo '部署失败，先重新核对数据兼容性再尝试恢复此前运行提交。' >&2
    "$MIND_APP_DIR/stop.sh" || return 1
    if ! task_layout_compatible "$task_previous"; then
      echo '当前数据不能安全交给旧源码；保持停机，未回退数据，请核对部署回执。' >&2
      return 1
    fi
    task_runtime_git checkout --detach "$task_previous" || return 1
    "$MIND_NODE" "$MIND_RUNTIME_DIR/scripts/verify-profile-install.mjs" "$MIND_PROFILE_DIR" || return 1
    task_layout_compatible "$task_previous" || return 1
    "$MIND_APP_DIR/launch.sh" --no-open || return 1
    return 1
  fi
}

case "${1:-status}" in
  check) task_check ;;
  status)
    echo "开发：$(task_git rev-parse --short HEAD) · $task_root"
    echo "运行磁盘：$(task_runtime_git rev-parse --short HEAD) · $MIND_RUNTIME_DIR"
    "$MIND_NODE" scripts/verify-profile-install.mjs "$MIND_PROFILE_DIR"
    echo '磁盘状态不代表浏览器已刷新或真实业务闭环已验收。'
    ;;
  deploy|rollback)
    exec 9>"$MIND_AUDIT_DIR/deploy.lock"
    flock -n 9 || { echo '另一次本地部署正在进行。' >&2; exit 1; }
    [[ "$(task_git rev-parse --path-format=absolute --git-common-dir)" == "$(task_runtime_git rev-parse --path-format=absolute --git-common-dir)" ]] || {
      echo '运行目录不属于此仓库，停止部署。' >&2; exit 1;
    }
    [[ "$(readlink -f -- "$MIND_PROFILE_DIR/node_modules/dsh-mind")" == "$(cd -- "$MIND_RUNTIME_DIR" && pwd -P)" ]] || {
      echo 'profile 的 dsh-mind 链接与本机配置不一致。' >&2; exit 1;
    }
    task_clean "$MIND_RUNTIME_DIR"
    if [[ "$1" == deploy ]]; then
      task_clean "$task_root"
      task_target="$(task_git rev-parse HEAD)"
      task_check
      task_clean "$task_root"
      [[ "$(task_git rev-parse HEAD)" == "$task_target" ]] || { echo '测试期间 HEAD 变化，停止部署。' >&2; exit 1; }
    else
      task_target="$(task_git rev-parse --verify 'refs/dsh-local/previous^{commit}')"
    fi
    task_clean "$MIND_RUNTIME_DIR"
    task_switch_runtime "$task_target"
    ;;
  *) echo '用法：bash scripts/local-dsh.sh [check|status|deploy|rollback]' >&2; exit 2 ;;
esac
