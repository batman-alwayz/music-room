// Song search with NO API key: uses YouTube's own public web search endpoint (what youtube.com calls).
// If you ever add a YT_API_KEY secret, the official API is used first and this is the fallback.
const API = 'https://www.googleapis.com/youtube/v3/';
const ISO = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
const isoSecs = s => {
  const m = ISO.exec(s || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};
const hms = s => (s || '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);   // "3:45" -> 225
const thumb = id => `https://i.ytimg.com/vi/${id}/default.jpg`;
const unesc = s => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const okDur = d => d >= 20 && d <= 1200;

// ---------- keyless: YouTube's web search ----------
const CTX = { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00', hl: 'en', gl: 'US' } };
const HDR = {
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://www.youtube.com',
  cookie: 'CONSENT=YES+1; SOCS=CAI'
};

export function parseSearch(j) {
  const out = [];
  const sections = j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  for (const s of sections) {
    for (const c of s.itemSectionRenderer?.contents || []) {
      const v = c.videoRenderer;
      if (!v?.videoId) continue;
      const dur = hms(v.lengthText?.simpleText);
      if (!okDur(dur)) continue;
      out.push({
        tid: v.videoId,
        title: v.title?.runs?.[0]?.text || '',
        artist: (v.ownerText?.runs?.[0]?.text || '').replace(/ - Topic$/, ''),
        dur, cover: thumb(v.videoId)
      });
    }
  }
  return out;
}

async function webSearch(q) {
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST', headers: HDR,
      body: JSON.stringify({ context: CTX, query: q, params: 'EgIQAQ%3D%3D' })   // videos only
    });
    return r.ok ? parseSearch(await r.json().catch(() => null)) : [];
  } catch { return []; }
}

// a pasted link: find that exact video; fall back to reading its watch page
async function webLookup(id) {
  const hit = (await webSearch(id)).find(t => t.tid === id);
  if (hit) return [hit];
  try {
    const html = await fetch('https://www.youtube.com/watch?v=' + id, { headers: HDR }).then(r => r.text());
    const len = +html.match(/"lengthSeconds":"(\d+)"/)?.[1];
    const title = html.match(/<meta name="title" content="([^"]*)"/)?.[1];
    const author = html.match(/"author":"([^"]*)"/)?.[1];
    return len && title ? [{ tid: id, title: unesc(title), artist: unesc(author || ''), dur: len, cover: thumb(id) }] : [];
  } catch { return []; }
}

// ---------- optional: official API (only if the YT_API_KEY secret exists) ----------
const apiTrack = i => ({
  tid: i.id, title: i.snippet.title,
  artist: (i.snippet.channelTitle || '').replace(/ - Topic$/, ''),
  dur: isoSecs(i.contentDetails.duration), cover: thumb(i.id)
});
async function apiDetails(ids, env) {
  const v = await fetch(API + 'videos?' + new URLSearchParams({
    part: 'contentDetails,snippet', id: ids.join(','), key: env.YT_API_KEY
  })).then(r => r.json());
  return (v.items || []).map(apiTrack).filter(t => okDur(t.dur));
}
async function apiSearch(q, env) {
  const s = await fetch(API + 'search?' + new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '10', q, key: env.YT_API_KEY
  })).then(r => r.json());
  const ids = (s.items || []).map(i => i.id?.videoId).filter(Boolean);
  return ids.length ? apiDetails(ids, env) : [];
}

// ---------- what the Worker calls ----------
export async function ytSearch(q, env) {
  const r = env.YT_API_KEY ? await apiSearch(q, env).catch(() => []) : [];
  return r.length ? r : webSearch(q);
}
export async function ytLookup(id, env) {
  const r = env.YT_API_KEY ? await apiDetails([id], env).catch(() => []) : [];
  return r.length ? r : webLookup(id);
}
export const linkId = q => q.match(/(?:[?&]v=|youtu\.be\/)([\w-]{11})/)?.[1] || null;
