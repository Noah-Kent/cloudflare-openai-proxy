"""Best-effort scan; report locations, never matched credential values."""
import re
import subprocess
import sys
from pathlib import Path

PATTERNS = [
    re.compile(rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}'),
    re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'(?im)^\s*PROXY_TOKEN\s*=\s*["\']?(?!local-test-|test-|YOUR_|\$)[A-Za-z0-9_-]{32,}'),
]
def git(*args):
    return subprocess.check_output(['git', *args])

def suspect(data):
    return any(pattern.search(data) for pattern in PATTERNS)

findings = []
paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
for name in set(paths):
    if name and Path(name).is_file() and suspect(Path(name).read_bytes()):
        findings.append('working tree: ' + name)
# --cached lists paths, not the staged bytes. Read index blob IDs independently
# so cleaning/deleting the working copy cannot hide a staged credential.
index_checked = 0
for entry in git('ls-files', '--stage', '-z').split(b'\0'):
    if not entry:
        continue
    metadata, _, name = entry.partition(b'\t')
    mode, oid, stage = metadata.split()
    if mode == b'160000':  # A gitlink references a separate repository, not a blob.
        continue
    index_checked += 1
    if suspect(git('cat-file', 'blob', oid.decode('ascii'))):
        findings.append('index: ' + name.decode(errors='surrogateescape') + ' [stage ' + stage.decode('ascii') + ']')
objects = git('rev-list', '--objects', '--all').decode().splitlines()
# Read each reachable object, including old blobs and commit messages; no secret content printed.
proc = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
checked = 0
for line in objects:
    oid, _, name = line.partition(' ')
    proc.stdin.write((oid + '\n').encode()); proc.stdin.flush()
    header = proc.stdout.readline().decode().split()
    size = int(header[2]); data = proc.stdout.read(size); proc.stdout.read(1)
    if header[1] in ('blob', 'commit'):
        checked += 1
        if suspect(data):
            findings.append('history: ' + (name or header[1]) + ' [' + oid[:12] + ']')
proc.stdin.close(); proc.wait()
if findings:
    print('Potential credentials found (values redacted):\n' + '\n'.join(findings))
    sys.exit(1)
print(f'No common credential patterns found: {len(set(paths) - {""})} working files, {index_checked} index entries, {checked} historical blobs/commits. Heuristic scan only.')
