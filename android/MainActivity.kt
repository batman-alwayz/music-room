package com.example.room

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.*
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import java.io.ByteArrayInputStream

// Two WebViews: `ui` shows the room page, `yt` (2x2, kept alive) plays YouTube Music.
// (Before, load() navigated the ONLY WebView away to music.youtube.com and the room UI vanished.)
class MainActivity : AppCompatActivity() {
  private lateinit var ui: WebView
  private lateinit var yt: WebView
  private var pendingSeek = 0.0
  private val roomHost = "room.example.workers.dev"          // <- your Worker's host

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(b: Bundle?) {
    super.onCreate(b)
    ui = WebView(this); yt = WebView(this)
    val root = FrameLayout(this)
    root.addView(ui, FrameLayout.LayoutParams(-1, -1))
    root.addView(yt, FrameLayout.LayoutParams(2, 2))
    setContentView(root)
    for (w in listOf(ui, yt)) {
      w.settings.javaScriptEnabled = true
      w.settings.domStorageEnabled = true
      w.settings.mediaPlaybackRequiresUserGesture = false
      w.webChromeClient = object : WebChromeClient() {}
    }

    ui.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
        val h = r.url.host ?: return true
        if (h == roomHost || h == "accounts.spotify.com") return false
        startActivity(Intent(Intent.ACTION_VIEW, r.url)); return true   // keep the bridge off other sites
      }
    }
    yt.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
        val h = r.url.host ?: return null
        if (h.contains("doubleclick") || h.contains("googlesyndication") || r.url.path?.contains("/pagead/") == true) {
          return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
        return null
      }
      override fun onPageFinished(v: WebView, url: String) {
        v.evaluateJavascript(AD_SKIP_JS, null)
        if (pendingSeek > 500) {
          val ms = pendingSeek; pendingSeek = 0.0
          v.postDelayed({ v.evaluateJavascript("window.bridge&&window.bridge.seek($ms)", null) }, 1500)
        }
      }
    }
    ui.addJavascriptInterface(Bridge(), "NativeBridge")
    yt.addJavascriptInterface(YtBridge(), "YtBridge")

    PlaybackService.seekHook = { ms -> runOnUiThread { yt.evaluateJavascript("window.bridge&&window.bridge.seek($ms)", null) } }
    PlaybackService.pauseHook = { runOnUiThread { yt.evaluateJavascript("window.bridge&&window.bridge.pause()", null) } }
    PlaybackService.skipHook = { runOnUiThread { ui.evaluateJavascript("window.voteSkip&&window.voteSkip()", null) } }

    ui.loadUrl("https://$roomHost/")
    val svc = Intent(this, PlaybackService::class.java)
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc) else startService(svc)
  }

  // called from the room page (ui)
  inner class Bridge {
    @JavascriptInterface fun position(): Double = PlaybackService.pos()
    @JavascriptInterface fun seek(ms: Double) { PlaybackService.seek(ms.toLong()) }
    @JavascriptInterface fun load(id: String, ms: Double) {
      runOnUiThread { pendingSeek = ms; yt.loadUrl("https://music.youtube.com/watch?v=$id") }
    }
    @JavascriptInterface fun pause() { PlaybackService.pause() }
  }

  // called from the YouTube Music page (yt)
  inner class YtBridge {
    @JavascriptInterface fun pos(ms: Double) { PlaybackService.setPos(ms) }
    @JavascriptInterface fun ended() {
      runOnUiThread { ui.evaluateJavascript("window.onYtmEnd&&window.onYtmEnd()", null) }
    }
    @JavascriptInterface fun adSkipped() {}
  }

  companion object {
    const val AD_SKIP_JS = """
      (function(){
        if (window.__roomInit) return; window.__roomInit = true;
        var v = function(){ return document.querySelector('video'); };
        var skipping = false;
        window.bridge = {
          play: function(){ var x=v(); x && x.play(); },
          pause: function(){ var x=v(); x && x.pause(); },
          seek: function(ms){ var x=v(); if(x) x.currentTime = ms/1000; },
          position: function(){ var x=v(); return x ? x.currentTime*1000 : 0; },
          onEnd: function(cb){ var x=v(); x && x.addEventListener('ended', cb); },
          reportAdSkip: function(){ YtBridge.adSkipped(); }
        };
        var hooked = null;
        setInterval(function(){
          var x = v(); if (!x) return;
          var ad = document.querySelector('.ad-showing') || document.querySelector('.ytp-ad-player-overlay');
          if (ad && x.duration > 1) {
            skipping = true; setTimeout(function(){ skipping = false; }, 1500);
            x.currentTime = x.duration - 0.1; window.bridge.reportAdSkip();
          }
          if (hooked !== x) {
            hooked = x;
            x.addEventListener('ended', function(){
              if (!skipping && !document.querySelector('.ad-showing')) YtBridge.ended();
            });
          }
          YtBridge.pos(x.currentTime*1000);
        }, 400);
      })();
    """
  }
}
