// Spotify track -> YouTube Music video. Needs the YT_API_KEY secret (YouTube Data API v3).
const ISO = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
const secs = s => {
  const m = ISO.exec(s || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};
const toks = s => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^a-z0-9\u00c0-\uffff ]+/g, ' ').split(/\s+/).filter(Boolean);
const jacc = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
};

export async function ytSearch(q, env) {
  if (!env.YT_API_KEY) return [];
  const s = await fetch('https://www.googleapis.com/youtube/v3/search?' + new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '8', q, key: env.YT_API_KEY
  })).then(r => r.json());
  const ids = (s.items || []).map(i => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const v = await fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({
    part: 'contentDetails,snippet', id: ids.join(','), key: env.YT_API_KEY
  })).then(r => r.json());
  return (v.items || []).map(i => ({
    id: i.id, title: i.snippet.title, channel: i.snippet.channelTitle, dur: secs(i.contentDetails.duration)
  }));
}

// YouTube has no real ISRC lookup: search the code and only accept a duration-exact hit.
export async function ytByIsrc(isrc, env, dur) {
  const c = await ytSearch(isrc, env);
  return c.find(x => Math.abs(x.dur - dur) <= 2) || null;
}

// Fingerprinting needs chromaprint (fpcalc/WASM) + a Spotify preview clip, which new Spotify
// apps no longer get. Kept as a hook; score() works fine without it.
export async function acoustid() { return null; }

export function score(c, t, fp) {
  const dur = Math.max(0, 1 - Math.abs(c.dur - t.dur) / 10);
  const title = jacc(toks(c.title), toks(t.title));
  const artist = jacc(toks(c.title + ' ' + c.channel), toks(t.artist));
  let conf = 0.5 * dur + 0.4 * title + 0.1 * artist;
  if (/live|cover|karaoke|remix|sped up|slowed/i.test(c.title) && !/live|cover|karaoke|remix|sped up|slowed/i.test(t.title)) conf *= 0.6;
  if (fp?.match) conf = Math.min(1, conf + 0.2);
  return { ...c, conf, how: 'search' };
}

export async function match(track, env) {
  if (track.isrc) {
    const hit = await ytByIsrc(track.isrc, env, track.dur);
    if (hit) return { ...hit, conf: 0.99, how: 'isrc' };
  }
  const fp = await acoustid(track.previewUrl, env);
  const cands = await ytSearch(`${track.title} ${track.artist}`, env);
  const best = cands.map(c => score(c, track, fp)).sort((a, b) => b.conf - a.conf)[0];
  return best && best.conf >= 0.5 ? best : null;
}
