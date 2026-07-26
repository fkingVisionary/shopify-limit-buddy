#!/usr/bin/env python3
"""Print one smoke *.summary.json as GitHub step-summary markdown."""
import json
import sys

path = sys.argv[1]
d = json.load(open(path))
mode = d.get("mode")
verdict = d.get("verdict") or "n/a"
cleared = " → ".join(d.get("ladderCleared") or []) or "(none)"
print(f"#### `{mode}` — **{verdict}**")
print(f"- wall: `{d.get('wall')}`")
print(f"- cleared: `{cleared}`")
print(f"- ip / transport: `{d.get('resolveIp')}` / `{d.get('transport')}`")
print(f"- apiTls: `{d.get('apiTlsNote')}`")
print("")
print("```json")
print(json.dumps(d, indent=2)[:4500])
print("```")
print("")
