import os, threading, time
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory
from freespot import FreeSpotify

TOKEN = os.environ.get('MIRROR_TOKEN', 'change-me')
COOKIE = Path(__file__).with_name('sp_t.txt')

app = Flask(__name__, static_folder='static')
_lock = threading.Lock()
_engine = None


def engine():
    global _engine
    with _lock:
        if _engine is None or not _engine.alive:
            _engine = FreeSpotify(COOKIE.read_text().strip())
        return _engine


def call(fn, *args):
    """Run a command; rebuild the engine once if the dealer socket died."""
    global _engine
    try:
        return fn(engine(), *args)
    except Exception:
        with _lock:
            _engine = None
        return fn(engine(), *args)


KILL_ADS = os.environ.get('KILL_ADS', '1') == '1'
_watch = {'id': None, 'pos': 0, 'tries': 0}


def ad_watchdog():
    """Free-tier ads are unskippable by button, but a fresh play command cuts them off."""
    while True:
        time.sleep(1.2)
        if not KILL_ADS or not _watch['id']:
            continue
        try:
            st = call(lambda e: e.now())
        except Exception:
            continue
        if st.get('type') == 'ad':
            if _watch['tries'] >= 4:      # give up on this track rather than loop forever
                continue
            _watch['tries'] += 1
            try:
                call(lambda e: e.play(_watch['id']))
                time.sleep(0.45)
                if _watch['pos'] > 4000:  # mid-roll ad: jump back to where it cut in
                    call(lambda e: e.seek(_watch['pos']))
            except Exception:
                pass
        else:
            _watch['tries'] = 0
            if st.get('position'):
                _watch['pos'] = st['position']


def authed():
    if request.headers.get('X-Token') == TOKEN:
        return True
    return request.cookies.get('t') == TOKEN


@app.get('/')
def index():
    return send_from_directory('static', 'index.html')


@app.get('/api/search')
def api_search():
    if not authed():
        return jsonify(error='unauthorised'), 401
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify(results=[])
    return jsonify(results=call(lambda e: e.search(q)))


@app.post('/api/play')
def api_play():
    if not authed():
        return jsonify(error='unauthorised'), 401
    track = request.json.get('id')
    _watch.update({'id': track, 'pos': 0, 'tries': 0})
    ok = call(lambda e: e.play(track))
    return jsonify(ok=ok)


@app.post('/api/pause')
def api_pause():
    if not authed():
        return jsonify(error='unauthorised'), 401
    return jsonify(ok=call(lambda e: e.pause()))


@app.post('/api/resume')
def api_resume():
    if not authed():
        return jsonify(error='unauthorised'), 401
    return jsonify(ok=call(lambda e: e.resume()))


@app.post('/api/volume')
def api_volume():
    if not authed():
        return jsonify(error='unauthorised'), 401
    return jsonify(ok=call(lambda e: e.volume(int(request.json['v']))))


@app.get('/api/now')
def api_now():
    if not authed():
        return jsonify(error='unauthorised'), 401
    try:
        return jsonify(call(lambda e: e.now()) or {})
    except Exception as exc:
        return jsonify(error=str(exc)), 500


if __name__ == '__main__':
    threading.Thread(target=ad_watchdog, daemon=True).start()
    app.run(host='0.0.0.0', port=8080, threaded=True)
