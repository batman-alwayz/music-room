import asyncio, json, random, string, threading, time
import requests, websockets

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
H = {'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors',
     'sec-fetch-site': 'same-origin', 'user-agent': UA}

def _connect(url):
    try:
        return websockets.connect(url, additional_headers={'User-Agent': UA})
    except TypeError:                      # websockets < 14
        return websockets.connect(url, extra_headers={'User-Agent': UA})

class FreeSpotify:
    """Premium-gated playback control, done through the web player's own endpoints."""

    def __init__(self, sp_t: str):
        self.s = requests.Session()
        self.sp_t = sp_t
        self.device_id = ''.join(random.choices(string.ascii_letters, k=40))
        self.conn_id = None
        self.token = None
        self.exp = 0
        self.alive = True
        self._auth()
        self._open_dealer()
        self._register()

    # --- auth -------------------------------------------------------
    def _auth(self):
        h = H | {'spotify-app-version': '1.1.48.530.g38509c6c',
                 'referer': 'https://accounts.spotify.com',
                 'cookie': f'sp_t={self.sp_t}'}
        r = self.s.get('https://open.spotify.com/get_access_token'
                       '?reason=transport&productType=web_player', headers=h)
        j = r.json()
        self.token = j['accessToken']
        self.exp = j['accessTokenExpirationTimestampMs'] / 1000

    def _h(self, **extra):
        h = H | {'authorization': f'Bearer {self.token}'}
        h.update(extra)
        return h

    def _fresh(self):
        if self.token is None or self.exp - 30 < time.time():
            self._auth()

    # --- dealer socket -> connection id -----------------------------
    def _open_dealer(self):
        def run():
            async def loop():
                url = f'wss://guc3-dealer.spotify.com/?access_token={self.token}'
                async with _connect(url) as ws:
                    try:
                        async for msg in ws:
                            try:
                                cid = (json.loads(msg).get('headers') or {}).get('Spotify-Connection-Id')
                            except Exception:
                                continue
                            if cid:
                                self.conn_id = cid
                    finally:
                        self.alive = False
            try:
                asyncio.run(loop())
            except Exception:
                pass

        threading.Thread(target=run, daemon=True).start()
        t0 = time.time()
        while not self.conn_id:
            if time.time() - t0 > 15:
                raise TimeoutError('no connection id from dealer')
            time.sleep(0.1)

    # --- register the fake device -----------------------------------
    def _register(self):
        dev = {"device": {"brand": "spotify",
                          "capabilities": {"change_volume": True, "enable_play_token": True,
                                           "supports_file_media_type": True,
                                           "play_token_lost_behavior": "pause",
                                           "disable_connect": True, "audio_podcasts": True,
                                           "video_playback": True,
                                           "manifest_formats": ["file_urls_mp3", "manifest_ids_video",
                                                                "file_urls_external", "file_ids_mp4",
                                                                "file_ids_mp4_dual"]},
                          "device_id": self.device_id, "device_type": "computer",
                          "metadata": {}, "model": "web_player", "name": "Mirror",
                          "platform_identifier": "web_player windows 10;chrome 122;desktop"},
               "connection_id": self.conn_id, "client_version": "harmony:4.11.0-af0ef98",
               "volume": 65535}
        r = self.s.post('https://guc-spclient.spotify.com/track-playback/v1/devices',
                        headers=self._h(), data=json.dumps(dev))
        r.raise_for_status()

        self.s.put(f'https://api.spotify.com/v1/me/notifications/user'
                   f'?connection_id={self.conn_id}', headers=self._h())

        r = self.s.put(f'https://guc-spclient.spotify.com/connect-state/v1/devices/hobs_{self.device_id}',
                       headers=self._h(**{'x-spotify-connection-id': self.conn_id}),
                       data=json.dumps({"member_type": "CONNECT_STATE",
                                        "device": {"device_info":
                                                   {"capabilities": {"can_be_player": False,
                                                                     "hidden": True}}}}))
        self.state = r.json()

    # --- target device ----------------------------------------------
    def _target(self):
        r = self.s.get('https://api.spotify.com/v1/me/player', headers=self._h())
        if r.status_code == 200 and r.json().get('device'):
            return r.json()['device']['id']
        r = self.s.get('https://api.spotify.com/v1/me/player/devices', headers=self._h())
        devs = r.json().get('devices', [])
        if not devs:
            raise RuntimeError('nothing playing — start Spotify on a device first')
        d = devs[0]['id']
        self.s.post(f'https://guc-spclient.spotify.com/connect-state/v1/connect/transfer/'
                    f'from/{self.device_id}/to/{d}', headers=self._h(),
                    data=json.dumps({'transfer_options': {'restore_paused': 'restore'}}))
        time.sleep(1)
        return d

    # --- search (not a playback endpoint, free accounts fine) -------
    def resolve(self, query: str):
        self._fresh()
        r = self.s.get('https://api.spotify.com/v1/search',
                       headers=self._h(), params={'q': query, 'type': 'track', 'limit': 1})
        items = r.json().get('tracks', {}).get('items', [])
        if not items:
            return None
        t = items[0]
        return {'id': t['id'], 'name': t['name'],
                'artist': ', '.join(a['name'] for a in t['artists'])}

    # --- play -------------------------------------------------------
    def play(self, track_id: str):
        self._fresh()
        tgt = self._target()
        uri = f'spotify:track:{track_id}'
        body = {"command": {"context": {"uri": uri, "url": f'context://{uri}', "metadata": {}},
                            "play_origin": {"feature_identifier": "harmony",
                                            "feature_version": "4.11.0-af0ef98"},
                            "options": {"license": "on-demand",
                                        "skip_to": {"track_index": 0},
                                        "player_options_override": {}},
                            "endpoint": "play"}}
        r = self.s.post(f'https://guc-spclient.spotify.com/connect-state/v1/player/command'
                        f'/from/{self.device_id}/to/{tgt}', headers=self._h(),
                        data=json.dumps(body))
        return r.status_code == 200

    def pause(self):
        self._fresh()
        tgt = self._target()
        return self.s.post(f'https://guc-spclient.spotify.com/connect-state/v1/player/command'
                           f'/from/{self.device_id}/to/{tgt}', headers=self._h(),
                           data=json.dumps({"command": {"endpoint": "pause"}})).status_code == 200

    def search(self, query, limit=5):
        self._fresh()
        r = self.s.get('https://api.spotify.com/v1/search', headers=self._h(),
                       params={'q': query, 'type': 'track', 'limit': limit})
        return [{'id': t['id'], 'name': t['name'],
                 'artist': ', '.join(a['name'] for a in t['artists']),
                 'art': (t['album']['images'][-1]['url'] if t['album']['images'] else '')}
                for t in r.json().get('tracks', {}).get('items', [])]

    def resume(self):
        return self._cmd({'command': {'endpoint': 'resume'}})

    def volume(self, pct):
        self._fresh()
        tgt = self._target()
        return self.s.put(
            f'https://guc-spclient.spotify.com/connect-state/v1/connect/volume'
            f'/from/{self.device_id}/to/{tgt}',
            headers=self._h(), data=json.dumps({'volume': int(pct * 655.35)})).status_code == 200

    def now(self):
        r = self.s.get('https://api.spotify.com/v1/me/player', headers=self._h())
        if r.status_code != 200:
            return {}
        j = r.json()
        item = j.get('item') or {}
        kind = j.get('currently_playing_type', '')
        if not kind and str(item.get('uri', '')).startswith('spotify:ad:'):
            kind = 'ad'
        return {'playing': j.get('is_playing', False),
                'name': item.get('name', ''),
                'artist': ', '.join(a['name'] for a in item.get('artists', [])),
                'type': kind,
                'position': j.get('progress_ms', 0),
                'volume': (j.get('device') or {}).get('volume_percent', 0)}

    def _cmd(self, body):
        self._fresh()
        tgt = self._target()
        return self.s.post(
            f'https://guc-spclient.spotify.com/connect-state/v1/player/command'
            f'/from/{self.device_id}/to/{tgt}',
            headers=self._h(), data=json.dumps(body)).status_code == 200

    def seek(self, ms):
        return self._cmd({'command': {'endpoint': 'seek_to', 'value': int(ms)}})
