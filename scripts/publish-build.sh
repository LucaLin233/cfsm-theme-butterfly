#!/bin/sh
# 把构建产物发布到 build 分支（作者约定：dist 放 build 分支，每次 build 记录一个 commit）。
#
# 做三件事：
#   1. 重新构建并校验，确保 dist/ 与 src/ 一致（不一致就中止，绝不发布半成品）；
#   2. 把 dist/ 的内容铺到 build 分支的**根目录**（index.html + assets/*，不带 dist/ 子目录），
#      另写一份 BUILD-INFO.json 记录版本与来源提交；
#   3. 生成一个独立 commit（message 记版本 + 来源提交）并推送到 origin/build。
#
# 用法：
#   sh scripts/publish-build.sh             # 构建并发布
#   sh scripts/publish-build.sh --dry-run   # 只计算，不写 ref、不推送
#
# 站点引用（二选一）：
#   .../tree/build              跟随最新构建（分支 ref，最长 1 小时生效）
#   .../tree/<build-commit>     固定版本（内容不可变）
set -eu
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

BRANCH=build

# 0) 工作区必须干净：发布的是**已提交**的内容，避免把未提交的 dist 发出去
if [ -n "$(git status --porcelain)" ]; then
  echo "错误：工作区有未提交改动，先提交再发布。" >&2
  git status --porcelain >&2
  exit 1
fi

# 1) 构建 + 校验
node scripts/build.mjs
node scripts/validate.mjs
if [ -n "$(git status --porcelain src dist)" ]; then
  echo "错误：构建后 dist/ 仍与仓库不一致（应为纯构建产物），先提交再发布。" >&2
  git status --porcelain src dist >&2
  exit 1
fi

ver=$(node -p "require('./package.json').version")
src_full=$(git rev-parse HEAD)
src_short=$(git rev-parse --short HEAD)
src_ref=$(git rev-parse --abbrev-ref HEAD)

# 2) 在临时目录把 dist 铺成根目录布局（不碰当前工作区）
tmp=$(mktemp -d)
idx=$(mktemp)
rm -f "$idx" # 临时索引：git 需要它「不存在」或合法
trap 'rm -rf "$tmp"; rm -f "$idx"' EXIT INT TERM

git archive --format=tar "HEAD:dist" | tar -xf - -C "$tmp"
# 注意：BUILD-INFO.json 不含构建时间戳 —— 同一来源重复发布会得到同一棵树，从而被下面的
# 「内容无变化则跳过」正确识别（构建时间由 commit 时间记录）。
cat > "$tmp/BUILD-INFO.json" <<EOF
{
  "version": "$ver",
  "sourceCommit": "$src_full",
  "sourceBranch": "$src_ref",
  "buildRef": "$BRANCH"
}
EOF

GIT_INDEX_FILE="$idx" GIT_WORK_TREE="$tmp" git add -A
tree=$(GIT_INDEX_FILE="$idx" git write-tree)

# 3) 生成 commit（内容没变就跳过，不留空提交）
parent=""
if git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null; then
  parent=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH^{commit}" || true)
fi
[ -n "$parent" ] || parent=$(git rev-parse -q --verify "refs/heads/$BRANCH^{commit}" || true)

msg="build: v$ver (source $src_short)"
note="build 分支根目录 = dist 内容（index.html + assets/*，无 dist/ 子目录）。
来源分支 $src_ref @ $src_full；由 scripts/publish-build.sh 发布。"
if [ -n "$parent" ]; then
  if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
    echo "build 分支已与 v$ver（$src_short）一致，无需发布。"
    exit 0
  fi
  new=$(git commit-tree "$tree" -p "$parent" -m "$msg" -m "$note")
else
  new=$(git commit-tree "$tree" -m "$msg" -m "$note")
fi

if [ "$DRY" = "1" ]; then
  echo "dry-run：tree=$tree commit=$new（未写 ref、未推送）"
  exit 0
fi

git update-ref "refs/heads/$BRANCH" "$new"
git push -q origin "$BRANCH"
echo "build -> $(git rev-parse --short "$new")  (v$ver, source $src_short)"
