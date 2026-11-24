#!/usr/bin/env python3
"""打包 hongdou-bridge 为 .xpi（Zotero 插件格式）

xpi 就是 zip，但 Zotero 要求 manifest.json 在根目录，且通常无顶层目录前缀。
"""
import zipfile
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "hongdou-siyuan-bridge-0.3.1.xpi")

# 需打包的文件（相对 ROOT）
FILES = [
    "manifest.json",
    "bootstrap.js",
]

def add_file(zf, relpath):
    arcname = relpath.replace("\\", "/")
    zf.write(os.path.join(ROOT, relpath), arcname)

def add_dir(zf, dirpath):
    base = os.path.join(ROOT, dirpath)
    for root, _, files in os.walk(base):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, ROOT).replace("\\", "/")
            zf.write(p, rel)

def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in FILES:
            add_file(zf, f)
        add_dir(zf, "chrome")
    size = os.path.getsize(OUT)
    print(f"✓ 打包完成: {OUT} ({size} bytes)")
    # 打印内容清单
    with zipfile.ZipFile(OUT, "r") as zf:
        for n in zf.namelist():
            print("  ", n)

if __name__ == "__main__":
    main()
