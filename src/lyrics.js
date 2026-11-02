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

const firstArtist = a => (a || '').split(/,|&|\bx\b|\bfeat\b|\bft\b|\band\b/i)[0].trim();

// -> { lrc, synced } | null (nothing found) | 'error' (the services could not be reached)
export async function lrclib(title, artist, dur) {
  const t = tidy(title), a = tidy(artist), a1 = firstArtist(a);
  const seen = new Set();
  const tries = [{ track_name: t, artist_name: a }, { track_name: t, artist_name: a1 }, { q: `${t} ${a}`.trim() }, { q: t }]
    .filter(q => { const k = JSON.stringify(q); if (seen.has(k)) return false; seen.add(k); return true; });
  let failed = 0;
  for (const q of tries) {
    const r = await get('https://lrclib.net/api/search?' + new URLSearchParams(q));
    if (!r.ok) { failed++; continue; }
    const hit = pickLyrics(r.data, dur);
    if (hit) return hit;
  }
  // second free source (plain text, not timed)
  if (t && a1) {
    const o = await get(`https://api.lyrics.ovh/v1/${encodeURIComponent(a1)}/${encodeURIComponent(t)}`);
    if (o.ok && typeof o.data?.lyrics === 'string' && o.data.lyrics.trim().length > 20) return { lrc: o.data.lyrics.trim(), synced: false };
  }
  return failed === tries.length ? 'error' : null;
}
