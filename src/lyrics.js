// Lyrics from LRCLIB (free, no key). Synced lyrics come as an LRC text with [mm:ss.xx] stamps.
const H = { 'user-agent': 'room-app/1.0 (private friends listening room)' };
const tidy = s => (s || '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|version|edit|mix|radio|single|bonus|mono|stereo|deluxe|acoustic|from)\b.*$/i, ' ')
  .replace(/\b(feat|ft)\.?\s.*$/i, ' ')
  .replace(/["\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim();

async function get(url) {
  try { const r = await fetch(url, { headers: H }); return r.ok ? { ok: true, data: await r.json() } : { ok: false }; }
  catch { return { ok: false }; }
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

// -> { lrc, synced } | null (nothing found) | 'error' (the service could not be reached)
export async function lrclib(title, artist, dur) {
  const t = tidy(title), a = tidy(artist);
  const tries = [{ track_name: t, artist_name: a }, { q: `${t} ${a}`.trim() }, { q: t }];
  let failed = 0;
  for (const q of tries) {
    const r = await get('https://lrclib.net/api/search?' + new URLSearchParams(q));
    if (!r.ok) { failed++; continue; }
    const hit = pickLyrics(r.data, dur);
    if (hit) return hit;
  }
  return failed === tries.length ? 'error' : null;
}
