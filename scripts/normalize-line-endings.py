#!/usr/bin/env python3
"""
normalize-line-endings.py — Fix line ending issues in the GetChat project.

Usage:
    python scripts/normalize-line-endings.py [--check] [path ...]

Modes:
    --check   Only report issues, do not fix them (exit 1 if issues found)
    (default) Fix issues in-place

Rules enforced:
    1. All source files use CRLF (\r\n) line endings
    2. No double-CR sequences (\r\r\n or \r\r)
    3. No triple-or-more consecutive blank lines
    4. Single trailing newline at end of file
    5. No trailing whitespace on any line
    6. No interleaved blank lines (every-other-line-blank pattern)
"""

import sys
import os

SOURCE_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx', '.mjs',
    '.rs', '.toml',
    '.css', '.scss',
    '.html',
    '.json',
    '.md',
}

SKIP_DIRS = {
    'node_modules', '.git', 'target', 'dist', 'gen',
    '__pycache__', '.next', '.turbo',
}

SKIP_PATHS = {'src-tauri/gen'}


def should_check(filepath, project_root):
    rel = os.path.relpath(filepath, project_root).replace(os.sep, '/')
    for sp in SKIP_PATHS:
        if rel.startswith(sp):
            return False
    _, ext = os.path.splitext(filepath)
    return ext in SOURCE_EXTENSIONS


def check_and_fix(filepath, fix):
    with open(filepath, 'rb') as f:
        data = f.read()
    if not data:
        return []

    issues = []

    # 1. Double-CR
    if b'\r\r' in data:
        issues.append('double-CR')
        if fix:
            data = data.replace(b'\r\r\n', b'\r\n').replace(b'\r\r', b'\r')

    # 2. Normalize to CRLF
    has_crlf = b'\r\n' in data
    has_bare_lf = b'\n' in data.replace(b'\r\n', b'')
    if has_bare_lf and not has_crlf:
        issues.append('pure-LF')
    elif has_bare_lf:
        issues.append('mixed-LF')
    if fix and has_bare_lf:
        data = data.replace(b'\r\n', b'\n').replace(b'\r', b'\n').replace(b'\n', b'\r\n')

    # 3. Decode
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return issues
    sep = '\r\n' if '\r\n' in text else '\n'
    lines = text.split(sep)

    # 4. Trailing whitespace
    tw = sum(1 for l in lines if l.strip() and l != l.rstrip())
    if tw:
        issues.append(f'trailing-whitespace({tw})')
        if fix:
            lines = [l.rstrip() if l.strip() else l for l in lines]

    # 5. Collapse 3+ blank lines to 2
    tb = sum(1 for i in range(len(lines)-2)
             if not lines[i].strip() and not lines[i+1].strip() and not lines[i+2].strip())
    if tb:
        issues.append(f'triple-blank-lines({tb})')
        if fix:
            cleaned, bc = [], 0
            for line in lines:
                if not line.strip():
                    bc += 1
                    if bc <= 2:
                        cleaned.append(line)
                else:
                    bc = 0
                    cleaned.append(line)
            lines = cleaned

    # 6. Interleaved blank lines
    non_blank = sum(1 for l in lines if l.strip())
    isolated = sum(1 for i in range(1, len(lines)-1)
                   if not lines[i].strip() and lines[i-1].strip() and lines[i+1].strip())
    if len(lines) > 10 and isolated > non_blank * 0.2:
        issues.append(f'interleaved-blanks({isolated})')
        if fix:
            cleaned, prev_blank = [], False
            for i, line in enumerate(lines):
                is_blank = not line.strip()
                if is_blank and not prev_blank:
                    if i + 1 < len(lines) and lines[i+1].strip():
                        prev_blank = True
                        continue
                cleaned.append(line)
                prev_blank = is_blank
            lines = cleaned

    # 7. Single trailing newline
    while lines and lines[-1] == '':
        lines.pop()
    lines.append('')

    if fix and issues:
        with open(filepath, 'wb') as f:
            f.write(('\r\n'.join(lines)).encode('utf-8'))
    return issues


def main():
    args = sys.argv[1:]
    fix, paths = True, []
    for arg in args:
        if arg == '--check':
            fix = False
        else:
            paths.append(arg)

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not paths:
        paths = [project_root]

    all_files = []
    for root_path in paths:
        if os.path.isfile(root_path):
            all_files.append(root_path)
        else:
            for root, dirs, files in os.walk(root_path):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for fname in files:
                    fpath = os.path.join(root, fname)
                    if should_check(fpath, project_root):
                        all_files.append(fpath)

    total = 0
    for fpath in sorted(all_files):
        issues = check_and_fix(fpath, fix)
        if issues:
            total += len(issues)
            rel = os.path.relpath(fpath, project_root)
            tag = 'FIXED' if fix else 'ISSUE'
            print(f'  [{tag}] {rel}: {", ".join(issues)}')

    if total == 0:
        print('All files OK')
    elif fix:
        print(f'\nFixed {total} issue(s)')
    else:
        print(f'\nFound {total} issue(s)')
        sys.exit(1)


if __name__ == '__main__':
    main()
