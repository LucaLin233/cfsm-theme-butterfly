#!/bin/sh
# 保持 stable 这个「别名分支」与 main 一致 —— **main 本身就是稳定线**。
#
# 分支约定（2026-09-15 起，作者 Huilang Liu 的发布流程）：
#   main   = 稳定版来源（src + dist），只有验证过的改动才合进来；
#   build  = 构建产物（根目录 = dist 内容），由 scripts/publish-build.sh 发布，每次 build 一个 commit；
#   test   = 后续开发分支，改完验证通过后再合回 main；
#   stable = main 的别名，仅为让早期指向 .../tree/stable/dist 的 theme_url 继续解析。
#
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
