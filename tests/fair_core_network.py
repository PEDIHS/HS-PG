"""Real VLESS transfers: upload/download aggregate, another user, and policy reset."""
import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

SIZE = 32768
IDS = {i: uuid.uuid4() for i in (1, 2)}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', str(SIZE))
        self.end_headers()
        self.wfile.write(b'x' * SIZE)

    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        assert len(data) == SIZE
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def transfer(proxy_port, http_port, user, upload=False):
    start = time.monotonic()
    with socket.create_connection(('127.0.0.1', proxy_port), timeout=15) as conn:
        header = b'\0' + IDS[user].bytes + b'\0\1' + struct.pack('!H', http_port) + b'\1\x7f\0\0\1'
        request = (f'{"POST" if upload else "GET"} / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {SIZE if upload else 0}\r\n\r\n').encode()
        conn.sendall(header + request + (b'x' * SIZE if upload else b''))
        response = bytearray()
        while chunk := conn.recv(65536):
            response.extend(chunk)
            # VLESS may keep the duplex connection open after the HTTP body.
            # Measure the completed transfer, independently of its idle timeout.
            if b'\r\n\r\n' in response[2:]:
                http_headers, received = response[2:].split(b'\r\n\r\n', 1)
                length = next(int(line.split(b':', 1)[1]) for line in http_headers.split(b'\r\n') if line.lower().startswith(b'content-length:'))
                if len(received) >= length:
                    break
        assert response[:2] == b'\0\0', response[:40]
        body = response[2:].split(b'\r\n\r\n', 1)[1]
        assert body == (b'ok' if upload else b'x' * SIZE)
    return time.monotonic() - start


def run(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        policy = root / 'fair-policy.json'
        port = free_port()
        config = {'log': {'loglevel': 'warning'}, 'inbounds': [{'listen': '127.0.0.1', 'port': port, 'tag': 'paid', 'protocol': 'vless', 'settings': {'decryption': 'none', 'clients': [{'id': str(IDS[i]), 'email': str(i)} for i in IDS]}}], 'outbounds': [{'protocol': 'freedom'}]}
        config_file = root / 'config.json'
        config_file.write_text(json.dumps(config))
        process = subprocess.Popen([str(Path(binary).resolve()), 'run', '-c', str(config_file)], env={**os.environ, 'HS_FAIR_POLICY_FILE': str(policy)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        def apply(rates):
            revision = hashlib.sha256(json.dumps(rates, sort_keys=True).encode()).hexdigest()
            temp = root / 'policy.tmp'
            temp.write_text(json.dumps({'revision': revision, 'rates': rates}))
            temp.replace(policy)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(process.stdout.read().decode())
                try:
                    if json.loads(Path(str(policy) + '.ack').read_text())['revision'] == revision:
                        return
                except (OSError, ValueError):
                    pass
                time.sleep(.05)
            raise AssertionError('Core did not acknowledge the policy')

        try:
            apply({'1\0paid': SIZE})
            start = time.monotonic()
            with concurrent.futures.ThreadPoolExecutor(3) as pool:
                upload = pool.submit(transfer, port, server.server_port, 1, True)
                download = pool.submit(transfer, port, server.server_port, 1)
                other = pool.submit(transfer, port, server.server_port, 2)
                other_time = other.result()
                upload.result()
                download.result()
            elapsed = time.monotonic() - start
            assert elapsed >= 1.8, f'Upload/download did not share a budget: {elapsed}'
            assert other_time < elapsed * .6, f'Unrelated user was throttled: {other_time}'
            apply({})
            restored = transfer(port, server.server_port, 1)
            assert restored < elapsed * .5, f'Policy removal did not restore speed: {restored}'
            print(f'Real VLESS test passed: shared upload/download {elapsed:.2f}s; other user {other_time:.2f}s; reset {restored:.2f}s')
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            server.shutdown()


if __name__ == '__main__':
    run(sys.argv[1])
