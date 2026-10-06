#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
发布前自检：模拟 Comfy Registry 的打包结果（git 跟踪文件 − .comfyignore），
扫描会触发 Registry 安全扫描（yara_scan）的字面串。

背景：本包 1.3.0 曾因 web/js 里出现 JS 的 Function 绑定写法（bind 紧跟左圆括号），
被 YARA 规则 $socket4 误判成 Python 的 socket 绑定调用，整个版本被判
NodeVersionStatusFlagged（不可安装）。该规则只做字面串匹配，**不区分语言、也不会
跳过注释**，所以注释里写了同样中招。

规则分两类作用域：
  * "all"     —— 所有被扫描的文件（JS/PY…）。真实事故证明这些串在 JS 里也会被命中。
  * "python"  —— 仅 .py 文件。避免把 JS 的 RegExp#exec 之类正常写法误报成 Python 危险调用。

用法：
    python tools/check_publish_hygiene.py          # 检查，有命中则退出码 1
    python tools/check_publish_hygiene.py --list   # 额外打印将被打包的文件清单

注意：本脚本自身必须留在 .comfyignore 里（它含有触发串的字面形式）。
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (意图说明, 作用域, 正则)
# 作用域 "all" = 所有被扫描文件；"python" = 仅 .py
RULES: list[tuple[str, str, str]] = [
    # 真实事故：JS 的 fn.bind(x) 被 $socket4（本意抓 Python socket 绑定）命中
    ("socket 绑定写法（YARA $socket4，会误伤 JS Function 绑定）", "all", r"\.bind\s*\("),
    # 网络操作：真实事故证明该规则会扫 JS 文件
    ("网络请求（python_network_operations）", "all",
     r"(urllib\.request|urlopen\s*\(|urlretrieve\s*\(|requests\.(get|post)\s*\(|http\.client|socket\.socket\s*\()"),
    # 以下只在 Python 里才构成语义危险，避免误报 JS
    ("环境变量读写（python_environment_manipulation）", "python", r"os\.environ"),
    ("命令执行（python_command_injection_risk）", "python", r"(subprocess|os\.system\s*\(|os\.popen\s*\()"),
    ("动态执行 / 混淆", "python", r"(?<![\w.])eval\s*\(|(?<![\w.])exec\s*\(|__import__\s*\(|marshal\.loads|zlib\.decompress"),
    ("运行时装包", "python", r"pip\s+install"),
]

SCAN_EXT = (".py", ".js", ".mjs", ".ts", ".cjs")
ALWAYS_SKIP_DIRS = (".git",)


def git_tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "-C", ROOT, "ls-files"], capture_output=True, text=True, check=True
    ).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]


def read_comfyignore() -> list[str]:
    path = os.path.join(ROOT, ".comfyignore")
    if not os.path.exists(path):
        return []
    patterns = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line)
    return patterns


def is_ignored(path: str, patterns: list[str]) -> bool:
    """按 .comfyignore 规则判断（gitignore 语法的常用子集）。"""
    parts = path.split("/")
    for pat in patterns:
        p = pat.rstrip("/")
        if "/" not in p:
            # 目录名或文件名，出现在任意层级都算
            if path == p or path.startswith(p + "/") or p in parts[:-1]:
                return True
            if fnmatch.fnmatch(os.path.basename(path), p):
                return True
        if fnmatch.fnmatch(path, p) or fnmatch.fnmatch(path, p + "/*"):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="打印将被打包的文件清单")
    args = ap.parse_args()

    tracked = git_tracked_files()
    patterns = read_comfyignore()
    shipped = [
        f for f in tracked
        if not any(seg in ALWAYS_SKIP_DIRS for seg in f.split("/"))
        and not is_ignored(f, patterns)
    ]

    print(f"git 跟踪文件 {len(tracked)} 个 → 将打包 {len(shipped)} 个"
          f"（.comfyignore 规则 {len(patterns)} 条）")
    if args.list:
        for f in shipped:
            print("   ", f)

    # --- 必需文件 ---
    problems: list[str] = []
    for req, why in [
        ("__init__.py", "ComfyUI 加载入口"),
        ("pyproject.toml", "Registry 元数据"),
    ]:
        if req not in shipped:
            problems.append(f"缺少必需文件: {req}（{why}）")

    # --- 扫描触发串 ---
    hits: list[tuple[str, str, int, str]] = []
    for f in shipped:
        if not f.endswith(SCAN_EXT):
            continue
        try:
            text = open(os.path.join(ROOT, f), encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        is_py = f.endswith(".py")
        for intent, scope, pat in RULES:
            if scope == "python" and not is_py:
                continue
            for m in re.finditer(pat, text):
                line_no = text[: m.start()].count("\n") + 1
                line = text.splitlines()[line_no - 1].strip()
                hits.append((f, intent, line_no, line[:120]))

    print()
    if hits:
        print(f"❌ 发现 {len(hits)} 处会触发安全扫描的字面串：")
        for f, intent, ln, line in hits:
            print(f"   {f}:{ln}  [{intent}]")
            print(f"       {line}")
        print()
        print("提示：注释里出现同样会命中（扫描器不看语言、也不跳过注释）。")
    else:
        print("✅ 未发现会触发安全扫描的字面串。")

    if problems:
        print()
        print("❌ 打包结构问题：")
        for p in problems:
            print("   ", p)

    return 1 if (hits or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
