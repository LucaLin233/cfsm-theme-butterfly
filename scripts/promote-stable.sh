#!/bin/sh
# 把 stable 分支快进到指定提交（默认 origin/main 的 HEAD）。
# 用途：theme_url 固定指向 .../tree/stable/dist，任何改动先落 main、验证通过后再提到 stable。
# 用法：sh scripts/promote-stable.sh [commit]
set -e
git fetch -q origin main
target="${1:-$(git rev-parse origin/main)}"
git rev-parse --verify "$target" >/dev/null 2>&1 || { echo "无效提交：$target" >&2; exit 1; }
# 只允许把 main 上已存在的提交提到 stable，避免把任意分支/未推送的提交发布出去
git merge-base --is-ancestor "$target" origin/main || { echo "拒绝：$target 不在 origin/main 上" >&2; exit 1; }
git branch -f stable "$target"
git push -q origin stable
echo "stable -> $(git rev-parse --short "$target")"
