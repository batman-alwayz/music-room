// Lyrics from LRCLIB (free, no key). Synced lyrics come as an LRC text with [mm:ss.xx] stamps.
const H = { 'user-agent': 'room-app/1.0 (private friends listening room)' };
const clean = s => (s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();

async function get(url) {
  try { const r = await fetch(url, { headers: H }); return r.ok ? await r.json() : null; } catch { return null; }
}

// best match from a LRCLIB search list: close in length, synced first
export function pickLyrics(list, dur) {
  if (!Array.isArray(list)) return null;
  const ok = list.filter(x => !x.instrumental && (x.syncedLyrics || x.plainLyrics));
  const near = x => !dur || Math.abs((x.duration || 0) - dur) <= 4;
  const j = ok.find(x => x.syncedLyrics && near(x)) || ok.find(x => x.syncedLyrics) || ok.find(x => near(x)) || ok[0];
  if (!j) return null;
  return j.syncedLyrics ? { lrc: j.syncedLyrics, synced: true } : { lrc: j.plainLyrics, synced: false };
}

export async function lrclib(title, artist, dur) {
  const t = clean(title), a = clean(artist);
  let hit = pickLyrics(await get('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: t, artist_name: a })), dur);
  if (!hit) hit = pickLyrics(await get('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${t} ${a}`.trim() })), dur);
  return hit;
}
