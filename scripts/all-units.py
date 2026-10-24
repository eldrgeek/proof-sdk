#!/usr/bin/env python3
"""Run every src/tests/*.test.ts in a worktree (not only the suites npm test wires) and record
exit codes, so a suite outside npm test cannot hide a regression (lesson of 2026-09-24: step 3
broke review-unified-history, which npm test does not run).
Usage: scripts/all-units.py <worktree> <out.json>, then scripts/all-units.py --compare live.json new.json
Written by Claude Opus 5.5 (CCc session 1997a29b) for Mike Wolf, 2026-09-24. About 26 minutes a run.
"""
import json, os, subprocess, sys, time, glob

def run(wt, out):
    env = dict(os.environ, PATH='/Users/mikewolf/.local/bin:' + os.environ.get('PATH', ''))
    results = {}
    files = sorted(glob.glob(os.path.join(wt, 'src/tests/*.test.ts')))
    for f in files:
        name = os.path.basename(f)
        start = time.time()
        try:
            r = subprocess.run(['npx', 'tsx', f], cwd=wt, env=env, capture_output=True, text=True, timeout=300)
            code = r.returncode
            tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        except subprocess.TimeoutExpired:
            code, tail = 'timeout', []
        results[name] = {'exit': code, 'secs': round(time.time() - start, 1), 'tail': tail}
        print(f"{name}: {code} ({results[name]['secs']}s)", flush=True)
    json.dump(results, open(out, 'w'), indent=1)

def compare(base, new):
    a, b = json.load(open(base)), json.load(open(new))
    for name in sorted(set(a) | set(b)):
        ea, eb = a.get(name, {}).get('exit'), b.get(name, {}).get('exit')
        if eb != 0 and ea == 0: print(f"NEW FAILURE {name}: {eb} | {b[name]['tail']}")
        elif eb != 0 and ea is None: print(f"NEW SUITE FAILS {name}: {eb} | {b[name]['tail']}")
        elif eb != 0: print(f"already failing on base {name}: base {ea}, now {eb}")
        elif ea not in (0, None): print(f"fixed {name}: base {ea}, now 0")
    fails = sum(1 for n in b if b[n]['exit'] != 0 and a.get(n, {}).get('exit') in (0, None))
    print(f"{len(b)} suites; {fails} fail here that pass (or do not exist) on the base")

if __name__ == '__main__':
    if sys.argv[1] == '--compare': compare(sys.argv[2], sys.argv[3])
    else: run(sys.argv[1], sys.argv[2])
