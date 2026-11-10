"""One posthoc HTTP held-body membership-revocation diagnostic; no provider use.

Run with --bun, --codex-source, --vector-source, and --out. Copies authored
files only; original source and evaluator are never modified. Cookies and
synthetic identifiers remain in memory and are not written to the facts file.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time


def manifest(root):
    files = {}
    for p in root.rglob('*'):
        rel = p.relative_to(root)
        if any(x in {'node_modules', 'dist', '.git'} for x in rel.parts):
            continue
        if p.is_file():
            files[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return files, digest


def run_arm(label, source, bun, out):
    facts = {'arm': label, 'posthoc': True, 'excludedFromOriginalGatesAndScores': True,
             'dispatchInstrumented': False, 'serverInternalAuthorizationTimingObserved': False,
             'requestMethod': 'POST', 'resource': 'customers', 'memberRole': 'member',
             'holdSecondsBeforeRevocation': 1.0, 'events': []}
    start = time.monotonic()
    def event(name, **values):
        facts['events'].append({'event': name, 'elapsedMs': round((time.monotonic()-start)*1000, 3), **values})
    original, original_digest = manifest(source)
    app = out / label / 'app'
    app.mkdir(parents=True, exist_ok=False)
    for rel in original:
        target = app / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / rel, target)
    copied, copied_digest = manifest(app)
    assert copied == original
    data = out / label / 'data'
    data.mkdir()
    reserve = socket.socket()
    reserve.bind(('127.0.0.1', 0))
    port = reserve.getsockname()[1]
    reserve.close()
    env = {k: os.environ[k] for k in ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'] if k in os.environ}
    env.update({'DATA_DIR': str(data), 'PORT': str(port)})
    logs = open(out / label / 'server.log', 'wb')
    process = subprocess.Popen([str(bun), 'server/index.ts'], cwd=app, env=env,
                               stdout=logs, stderr=subprocess.STDOUT,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    connections = []
    def request(method, route, body=None, cookie=None):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
        headers = {'Content-Type': 'application/json'}
        if cookie:
            headers['Cookie'] = cookie
        payload = None if body is None else json.dumps(body).encode()
        conn.request(method, route, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        result = json.loads(raw) if raw else None
        status, set_cookie = response.status, response.getheader('Set-Cookie')
        conn.close()
        return status, result, set_cookie.split(';', 1)[0] if set_cookie else None
    def held(name, cookie, route):
        payload = json.dumps({'name': name, 'email': '', 'company': '', 'notes': ''}, separators=(',', ':')).encode()
        prefix, suffix = payload[:-1], payload[-1:]
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
        conn.putrequest('POST', route)
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(len(payload)))
        conn.putheader('Cookie', cookie)
        conn.endheaders()
        conn.send(prefix)
        connections.append(conn)
        event(name + ':headers_and_partial_body_sent', totalBodyBytes=len(payload), partialBodyBytes=len(prefix), withheldBodyBytes=len(suffix))
        time.sleep(1.0)
        readable = False
        import select
        if select.select([conn.sock], [], [], 0)[0]:
            readable = bool(conn.sock.recv(1, socket.MSG_PEEK))
        event(name + ':pre_release_observation', responseBytesAvailable=readable)
        assert not readable, 'Unexpected response before held body completed'
        return conn, suffix
    def release(name, conn, suffix):
        event(name + ':body_release_started')
        conn.send(suffix)
        event(name + ':final_body_byte_sent', finalBodyBytes=len(suffix))
        response = conn.getresponse()
        raw = response.read()
        body = json.loads(raw) if raw else None
        event(name + ':response_received', status=response.status)
        conn.close()
        return response.status, body
    try:
        for _ in range(80):
            if process.poll() is not None:
                raise RuntimeError('Owned server exited during startup')
            try:
                request('GET', '/api/auth/me')
                break
            except (OSError, http.client.HTTPException):
                time.sleep(.1)
        else:
            raise RuntimeError('Owned server not ready within eight seconds')
        event('server_ready')
        password = 'Posthoc-Synthetic-Password-2026'
        st, owner, owner_cookie = request('POST', '/api/auth/signup', {'name': 'Diagnostic owner', 'email': 'owner@example.invalid', 'password': password})
        assert st == 201
        st, member, member_cookie = request('POST', '/api/auth/signup', {'name': 'Diagnostic member', 'email': 'member@example.invalid', 'password': password})
        assert st == 201
        workspace = owner['workspace']['id']
        member_id = member['user']['id']
        w = '/api/w/' + workspace
        st, invite, _ = request('POST', w + '/invites', {'email': 'member@example.invalid', 'role': 'member'}, owner_cookie)
        assert st == 201
        st, _, _ = request('POST', '/api/invites/accept', {'token': invite['invite']['token']}, member_cookie)
        assert st == 200
        event('synthetic_fixture_ready')
        route = w + '/customers'
        conn, suffix = held('no_revocation_control', member_cookie, route)
        status, _ = release('no_revocation_control', conn, suffix)
        facts['noRevocationControlStatus'] = status
        assert 200 <= status < 300
        st, customers, _ = request('GET', route, cookie=owner_cookie)
        facts['noRevocationControlPersisted'] = any(c['name'] == 'no_revocation_control' for c in customers['customers'])
        assert facts['noRevocationControlPersisted']
        conn, suffix = held('revocation_case', member_cookie, route)
        event('owner_revocation_dispatch')
        status, _, _ = request('DELETE', w + '/members/' + member_id, cookie=owner_cookie)
        event('owner_revocation_response_received', status=status)
        facts['revocationStatus'] = status
        assert 200 <= status < 300
        status, _, _ = request('POST', route, {'name': 'fresh_after_revocation'}, member_cookie)
        event('fresh_after_revocation_response_received', status=status)
        facts['freshAfterRevocationStatus'] = status
        assert status in [401, 403, 404]
        status, body = release('revocation_case', conn, suffix)
        facts['heldAfterRevocationStatus'] = status
        facts['heldAfterRevocationErrorCode'] = body.get('error', {}).get('code') if isinstance(body, dict) else None
        st, customers, _ = request('GET', route, cookie=owner_cookie)
        names = [c['name'] for c in customers['customers']]
        facts['heldAfterRevocationPersisted'] = 'revocation_case' in names
        facts['freshAfterRevocationPersisted'] = 'fresh_after_revocation' in names
        facts['positiveStaleAuthorityWriteObserved'] = 200 <= status < 300 and facts['heldAfterRevocationPersisted']
        facts['denialAndNoWriteObservedForThisSchedule'] = status in [401, 403, 404] and not facts['heldAfterRevocationPersisted']
        facts['diagnosticCompleted'] = True
        event('owner_persistence_verification_completed')
    except Exception as error:
        facts['diagnosticCompleted'] = False
        facts['diagnosticErrorType'] = type(error).__name__
        facts['diagnosticError'] = str(error)[:180]
    finally:
        for connection in connections:
            connection.close()
        facts['ownedProcessAliveBeforeCleanup'] = process.poll() is None
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        logs.close()
        facts['ownedProcessExitedAfterCleanup'] = process.poll() is not None
        facts['cleanupTargetedOnlyOwnedPopenProcess'] = True
        check = socket.socket()
        check.settimeout(.5)
        facts['ownedPortClosedAfterCleanup'] = check.connect_ex(('127.0.0.1', port)) != 0
        check.close()
        after_original, after_digest = manifest(source)
        after_copy, after_copy_digest = manifest(app)
        facts['sourceIntegrity'] = {'authoredFileCount': len(original), 'originalManifestSha256Before': original_digest,
            'originalManifestSha256After': after_digest, 'copiedManifestSha256Before': copied_digest,
            'copiedManifestSha256After': after_copy_digest, 'originalUnchanged': original == after_original,
            'copyUnchanged': copied == after_copy}
        (out / label / 'facts.json').write_text(json.dumps(facts, indent=2) + '\n', encoding='utf-8')
    return facts


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for arg in ['bun', 'codex-source', 'vector-source', 'out']:
        parser.add_argument('--' + arg, required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    result = {'kind': 'posthoc-held-body-revocation-diagnostic-v1', 'paidProviderCalls': 0,
              'browserCalls': 0, 'originalGateOrQualityScoreChanges': False,
              'schedule': 'Send HTTP headers and all but the final JSON byte; hold one second; receive successful owner revocation and fresh-denial responses before releasing the final byte.',
              'limits': ['Server dispatch and the authorization checkpoint are not instrumented.',
                         'A positive accepted and persisted write establishes this schedule only.',
                         'Denial on this schedule does not establish safety for every schedule.'], 'arms': {}}
    result['bunVersion'] = subprocess.check_output([str(args.bun), '--version'], text=True).strip()
    for label, source in [('codex', args.codex_source), ('vector', args.vector_source)]:
        result['arms'][label] = run_arm(label, source.resolve(), args.bun.resolve(), args.out.resolve())
    (args.out / 'facts.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({label: {k: value for k, value in facts.items() if k in [
        'diagnosticCompleted', 'diagnosticErrorType', 'diagnosticError', 'noRevocationControlStatus',
        'freshAfterRevocationStatus', 'heldAfterRevocationStatus', 'heldAfterRevocationPersisted',
        'positiveStaleAuthorityWriteObserved', 'ownedProcessExitedAfterCleanup', 'ownedPortClosedAfterCleanup']}
        for label, facts in result['arms'].items()}, indent=2))
