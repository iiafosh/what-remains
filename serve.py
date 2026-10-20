"""Local server for What Remains that never lets the browser cache files,
so every edit shows up on a normal reload.  Usage: python serve.py [port]"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', 8080))
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    print(f'What Remains: http://localhost:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
