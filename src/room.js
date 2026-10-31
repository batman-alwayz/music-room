const QUOTA = 10;                                            // songs one person may have queued

export class Room {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.s = {
      room: null, queue: [], playing: null, armed: {}, present: {}, part: {},
      votes: [], pvotes: [], ended: {}, hist: [],
      startAt: 0, goAt: 0, endAt: 0, seq: 0, paused: false, pos: 0
    };
    state.blockConcurrencyWhile(async () => {
      const r = await state.storage.get('s');
      if (r) this.s = { ...this.s, ...r };
      // drop people whose socket died while we were evicted
      const live = new Set(state.getWebSockets().map(w => w.deserializeAttachment()?.id));
      for (const id of Object.keys(this.s.present)) if (!live.has(id)) delete this.s.present[id];
    });
  }

  async fetch(req) {
    const path = new URL(req.url).pathname.slice(1);
    const room = req.headers.get('x-room');
    if (!this.s.room && room) { this.s.room = room; await this.state.storage.put('s', this.s); }
    if (path === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const [c, s] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(s);
      s.serializeAttachment({ id: req.headers.get('x-member') });
      return new Response(null, { status: 101, webSocket: c });
    }
    if (path === 'state') return this.reply();
    const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    await this.on(path, b, req.headers.get('x-member'));
    return this.reply();
  }

  reply() {
    return new Response(JSON.stringify({ s: this.s, now: Date.now() }), {
      headers: { 'content-type': 'application/json' }
    });
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (a?.id && m?.t) await this.on(m.t, m, a.id);
  }
  async webSocketClose(ws) { await this.drop(ws); }
  async webSocketError(ws) { await this.drop(ws); }

  async drop(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    const another = this.state.getWebSockets().some(w => w !== ws && w.deserializeAttachment()?.id === a.id);
    if (another) return;                                   // second tab of the same person
    delete this.s.present[a.id];
    delete this.s.armed[a.id];
    if (this.s.playing && this.allEnded()) await this.advance();
    this.maybeStart();
    await this.commit();
  }

  // people who count for the gate: present and not "away"
  active() { return Object.keys(this.s.present).filter(id => !this.s.present[id].away); }
  admin(id) { return !!this.s.present[id]?.admin; }
  allEnded() {
    const ids = Object.keys(this.s.part).filter(id => this.s.present[id] && !this.s.present[id].away);
    return ids.every(id => this.s.ended[id]);              // nobody left who started it -> done
  }
  // 60% of the people present, or the room's admin, decide skip / back
  tally(key, who) {
    const s = this.s;
    if (!s[key].includes(who)) s[key].push(who);
    const need = Math.ceil(this.active().length * 0.6);
    return this.admin(who) || s[key].filter(id => s.present[id]).length >= need;
  }

  async on(t, b, who) {
    const s = this.s;
    if (t !== 'join' && !s.present[who]) return;

    switch (t) {
      case 'join': {
        const m = await this.env.DB.prepare('SELECT id,name,product,provider FROM members WHERE id=?').bind(who).first();
        if (!m) return;
        const r = await this.env.DB.prepare('SELECT admin_ids FROM rooms WHERE id=?').bind(s.room).first();
        const owner = (r?.admin_ids || '').split(',').includes(who);       // the room's creator is its admin
        s.present[who] = { id: who, name: m.name, product: m.product, provider: m.provider, admin: owner, away: false };
        s.armed[who] = !s.playing;                         // mid-song joiners wait for the next track
        break;
      }
      case 'arm': case 'ready': s.armed[who] = true; s.present[who].away = false; break;
      case 'unarm': s.armed[who] = false; break;
      case 'away':
        s.present[who].away = !!b.v;
        if (b.v) s.armed[who] = false;
        break;

      case 'add': {
        if (!b.tid || !(Number(b.dur) > 0)) break;
        if (s.playing?.tid === b.tid || s.queue.some(q => q.tid === b.tid)) break;   // idempotent
        if (s.queue.filter(q => q.by === who).length >= QUOTA) break;
        const track = {
          tid: b.tid, title: b.title, artist: b.artist, dur: Number(b.dur),
          yt_id: b.tid, cover: b.cover, by: who, at: Date.now()
        };
        const burst = s.queue.slice(-2).filter(q => q.by === who).length;
        let at = s.queue.length;
        if (burst >= 2) {
          const i = s.queue.findLastIndex(q => q.by !== who);
          if (i >= 0) at = i + 1;
        }
        s.queue.splice(at, 0, track);
        break;
      }
      case 'addpl': {                                       // queue one of MY playlists, in order
        const { results } = await this.env.DB.prepare(
          `SELECT t.tid,t.title,t.artist,t.dur,t.cover FROM playlist_tracks t
           JOIN playlists p ON p.id = t.playlist WHERE p.id = ? AND p.owner = ? ORDER BY t.pos`
        ).bind(b.id, who).all();
        let free = QUOTA - s.queue.filter(q => q.by === who).length;
        for (const r of results || []) {
          if (free <= 0) break;
          if (s.playing?.tid === r.tid || s.queue.some(q => q.tid === r.tid)) continue;
          s.queue.push({ tid: r.tid, title: r.title, artist: r.artist, dur: r.dur, yt_id: r.tid, cover: r.cover, by: who, at: Date.now() });
          free--;
        }
        break;
      }
      case 'remove': {
        const q = s.queue.find(x => x.tid === b.tid);
        if (q && (q.by === who || this.admin(who))) s.queue = s.queue.filter(x => x.tid !== b.tid);
        break;
      }
      case 'move': {
        const i = s.queue.findIndex(q => q.tid === b.tid);
        if (i < 0 || !(s.queue[i].by === who || this.admin(who))) break;
        const [x] = s.queue.splice(i, 1);
        s.queue.splice(Math.max(0, Math.min(s.queue.length, Number(b.pos) || 0)), 0, x);
        break;
      }

      // ---- transport ----
      case 'pause':                                         // anyone can pause / resume for the whole room
        if (!s.playing || s.paused) break;
        s.paused = true;
        s.pos = Math.max(0, Date.now() - s.startAt);
        this.state.storage.deleteAlarm();
        break;
      case 'resume':
        if (!s.playing || !s.paused) break;
        s.paused = false;
        s.goAt = Date.now() + 1500;                         // short lead so everyone restarts together
        s.startAt = s.goAt - s.pos;
        s.endAt = s.startAt + s.playing.dur * 1000 + 2500;
        this.state.storage.setAlarm(s.endAt);
        break;
      case 'skip':
        if (!s.playing) break;
        if (this.tally('votes', who)) await this.advance();
        break;
      case 'prev':                                          // restart (after 5s) or go to the previous song
        if (!s.playing && !s.hist.length) break;
        if (this.tally('pvotes', who)) await this.back();
        break;

      case 'ended': {
        if (b.seq !== undefined && b.seq !== s.seq) break;  // stale report from the previous track
        if (s.playing && !s.paused) s.ended[who] = true;
        break;
      }
      case 'live': s.present[who].live = !!b.v; break;      // client says its player is really playing
      case 'late': if (s.playing) s.part[who] = true; break; // "join this song now"
      case 'seek': {                                        // admin resync of the whole room
        if (!s.playing || !this.admin(who)) break;
        s.startAt = Date.now() - Math.max(0, Number(b.ms) || 0);
        s.endAt = s.startAt + s.playing.dur * 1000 + 2500;
        if (!s.paused) this.state.storage.setAlarm(s.endAt);
        break;
      }
      case 'progress':
        s.present[who].ms = Number(b.ms) || 0;
        this.broadcast();                                   // cheap: no storage write
        return;
    }

    if (s.playing && this.allEnded()) await this.advance();
    this.maybeStart();
    await this.commit();
  }

  // everyone armed, nothing playing -> countdown, then 0:00 for all
  maybeStart() {
    const s = this.s;
    if (s.playing || !s.queue.length) return;
    const all = this.active();
    if (!all.length || !all.every(id => s.armed[id])) return;
    s.playing = s.queue.shift();
    s.seq++;
    s.paused = false; s.pos = 0;
    s.startAt = Date.now() + 3200;
    s.goAt = s.startAt;
    s.endAt = s.startAt + s.playing.dur * 1000 + 2500;
    s.votes = []; s.pvotes = []; s.ended = {};
    s.part = Object.fromEntries(all.map(id => [id, true]));
    for (const id of all) { s.armed[id] = false; s.present[id].live = false; }
    this.state.storage.setAlarm(s.endAt);                   // setTimeout dies when the DO hibernates
  }

  // a stalled device must not hold the room forever
  async alarm() {
    const s = this.s;
    if (s.playing && !s.paused && Date.now() >= s.endAt - 200) {
      await this.advance();
      this.maybeStart();
      await this.commit();
    }
  }

  stop() {
    const s = this.s;
    s.playing = null; s.votes = []; s.pvotes = []; s.ended = {}; s.part = {}; s.paused = false; s.pos = 0;
  }

  async advance() {
    const s = this.s;
    if (s.playing) {
      s.hist.push(s.playing);
      if (s.hist.length > 20) s.hist.shift();
      try {
        await this.env.DB.prepare('INSERT INTO plays (room,tid,added_by,listened,at) VALUES (?,?,?,?,?)')
          .bind(s.room, s.playing.tid, s.playing.by, s.playing.dur, Date.now()).run();
      } catch {}
    }
    this.stop();
  }

  // "previous": within the first 5s go to the last song, later just restart this one
  async back() {
    const s = this.s;
    const cur = s.playing;
    const elapsed = !cur ? 0 : s.paused ? s.pos : Date.now() - s.startAt;
    if (cur) s.queue.unshift(cur);
    if (!cur || elapsed <= 5000) {
      const prev = s.hist.pop();
      if (prev) s.queue.unshift(prev);
    }
    this.stop();
  }

  async commit() {
    await this.state.storage.put('s', this.s);
    this.broadcast();
  }

  broadcast() {
    const f = JSON.stringify({ s: this.s, now: Date.now() });
    for (const ws of this.state.getWebSockets()) { try { ws.send(f); } catch {} }
  }
}
