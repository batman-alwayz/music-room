export class Room {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.s = {
      queue: [], playing: null, armed: {}, present: {}, part: {},
      votes: [], ended: {}, startAt: 0, endAt: 0, seq: 0
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

  // people who count for the gate: present and not "away" (e.g. Spotify app not running)
  active() { return Object.keys(this.s.present).filter(id => !this.s.present[id].away); }
  admin(id) { return !!this.s.present[id]?.admin; }
  allEnded() {
    const ids = Object.keys(this.s.part).filter(id => this.s.present[id] && !this.s.present[id].away);
    return ids.every(id => this.s.ended[id]);              // nobody left who started it -> done
  }

  async on(t, b, who) {
    const s = this.s;
    if (t !== 'join' && !s.present[who]) return;

    switch (t) {
      case 'join': {
        const m = await this.env.DB.prepare('SELECT id,name,product,provider,admin FROM members WHERE id=?').bind(who).first();
        if (!m) return;
        s.present[who] = { id: who, name: m.name, product: m.product, provider: m.provider, admin: !!m.admin, away: false };
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
        if (s.queue.filter(q => q.by === who).length >= 3) break;                     // quota
        const track = {
          tid: b.tid, title: b.title, artist: b.artist, album: b.album, dur: Number(b.dur),
          yt_id: b.tid, cover: b.cover,
          by: who, at: Date.now()
        };
        const burst = s.queue.slice(-2).filter(q => q.by === who).length;
        let at = s.queue.length;
        if (burst >= 2) {
          const i = s.queue.findLastIndex(q => q.by !== who);
          if (i >= 0) at = i + 1;                          // (old code inserted at 0 when nobody else had a song)
        }
        s.queue.splice(at, 0, track);
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
      case 'skip': {
        if (!s.playing) break;
        if (!s.votes.includes(who)) s.votes.push(who);
        const need = Math.ceil(this.active().length * 0.6);
        if (s.votes.filter(v => s.present[v]).length >= need || this.admin(who)) await this.advance();
        break;
      }
      case 'ended': {
        if (b.seq !== undefined && b.seq !== s.seq) break;  // stale report from the previous track
        if (s.playing) s.ended[who] = true;
        break;
      }
      case 'seek': {                                        // admin resync of the whole room
        if (!s.playing || !this.admin(who)) break;
        s.startAt = Date.now() - Math.max(0, Number(b.ms) || 0);
        s.endAt = s.startAt + s.playing.dur * 1000 + 2500;
        this.state.storage.setAlarm(s.endAt);
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
    s.startAt = Date.now() + 3200;
    s.endAt = s.startAt + s.playing.dur * 1000 + 2500;
    s.votes = []; s.ended = {};
    s.part = Object.fromEntries(all.map(id => [id, true]));
    for (const id of all) s.armed[id] = false;
    this.state.storage.setAlarm(s.endAt);                   // setTimeout dies when the DO hibernates
  }

  // a stalled device must not hold the room forever
  async alarm() {
    if (this.s.playing && Date.now() >= this.s.endAt - 200) {
      await this.advance();
      this.maybeStart();
      await this.commit();
    }
  }

  async advance() {
    const s = this.s;
    if (s.playing) {
      try {
        await this.env.DB.prepare('INSERT INTO plays (room,tid,added_by,listened,at) VALUES (?,?,?,?,?)')
          .bind('main', s.playing.tid, s.playing.by, s.playing.dur, Date.now()).run();
      } catch {}
    }
    s.playing = null; s.votes = []; s.ended = {}; s.part = {};
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
