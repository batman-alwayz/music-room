// every player: position() -> ms (or null), seek(ms), play(videoId, ms), pause(), end(durMs) -> Promise, cancel()

// ytm: native shell (Android / iOS) plays YouTube Music in a hidden WebView
export const ytm = send => ({
  position: async () => Number(await send('position')) || 0,
  seek: ms => send('seek', ms),
  play: (id, ms) => send('load', { id, ms }),
  pause: () => send('pause'),
  end: () => new Promise(r => { window.onYtmEnd = r; }),
  cancel: () => { window.onYtmEnd = null; }
});

// web: YouTube's official iframe player, for a laptop/desktop browser tab (also handy for testing)
let ytApi;
const loadYT = () => ytApi ||= new Promise(res => {
  if (window.YT?.Player) return res();
  window.onYouTubeIframeAPIReady = res;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
});
export const web = elId => {
  let p, endRes = null;
  const ready = loadYT().then(() => new Promise(res => {
    p = new YT.Player(elId, {
      height: '120', width: '200', playerVars: { playsinline: 1, controls: 0 },
      events: {
        onReady: res,
        onStateChange: e => { if (e.data === 0 && endRes) { endRes(); endRes = null; } }
      }
    });
  }));
  return {
    position: async () => { await ready; return p.getPlayerState() === 1 ? p.getCurrentTime() * 1000 : null; },
    seek: async ms => { await ready; p.seekTo(ms / 1000, true); },
    play: async (id, ms) => { await ready; p.loadVideoById({ videoId: id, startSeconds: ms / 1000 }); },
    pause: async () => { await ready; p.pauseVideo(); },
    end: () => new Promise(r => { endRes = r; }),
    cancel: () => { endRes = null; }
  };
};

// manual (add ?manual to the URL): countdown only, you press play in your own app
export const manual = (getState, now) => {
  let timer = null;
  return {
    position: () => now() - getState().startAt,
    seek: () => {}, play: () => {}, pause: () => {},
    end: dur => new Promise(r => {
      timer = setTimeout(r, Math.max(0, getState().startAt + dur - now()));
    }),
    cancel: () => clearTimeout(timer)
  };
};

// everyone, free or Premium, plays through YouTube now
export function routeFor() {
  return { player: window.NativeBridge || window.webkit?.messageHandlers?.native ? 'ytm' : 'web', ads: true, skip: true };
}
