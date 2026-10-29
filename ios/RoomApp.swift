import SwiftUI
import WebKit
import MediaPlayer

// iOS shell: the room page in one WKWebView, YouTube Music in a hidden 2x2 one.
// Xcode: New Project -> iOS App (SwiftUI) named "Room". Replace the generated files with
// RoomApp.swift + AudioSession.swift. Signing & Capabilities -> + Capability -> Background Modes -> Audio.

@main
struct RoomApp: App {
  init() { configure() }
  var body: some Scene { WindowGroup { ShellView().ignoresSafeArea() } }
}

struct ShellView: UIViewRepresentable {
  func makeUIView(context: Context) -> UIView { Shell.shared.root }
  func updateUIView(_ v: UIView, context: Context) {}
}

final class Shell: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Shell()
  let roomURL = URL(string: "https://room.example.workers.dev/")!      // <- your Worker URL
  let root = UIView()
  var ui: WKWebView!
  var yt: WKWebView!
  var pendingSeek = 0.0

  override init() {
    super.init()
    // room page
    let uiCfg = WKWebViewConfiguration()
    uiCfg.allowsInlineMediaPlayback = true
    uiCfg.mediaTypesRequiringUserActionForPlayback = []
    uiCfg.userContentController.add(self, name: "native")
    ui = WKWebView(frame: .zero, configuration: uiCfg)
    ui.navigationDelegate = self
    ui.frame = root.bounds
    ui.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    root.addSubview(ui)

    // hidden YouTube Music player
    let ytCfg = WKWebViewConfiguration()
    ytCfg.allowsInlineMediaPlayback = true
    ytCfg.mediaTypesRequiringUserActionForPlayback = []
    ytCfg.userContentController.add(self, name: "yt")
    ytCfg.userContentController.addUserScript(
      WKUserScript(source: Shell.shim + Shell.adSkipJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    installAdBlock(ytCfg.userContentController) {}
    yt = WKWebView(frame: CGRect(x: 0, y: 0, width: 2, height: 2), configuration: ytCfg)
    yt.navigationDelegate = self
    root.addSubview(yt)

    // lock-screen "next" = the same skip vote as the in-app button
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "Room"]
    MPRemoteCommandCenter.shared().nextTrackCommand.addTarget { [weak self] _ in
      self?.ui.evaluateJavaScript("window.voteSkip&&window.voteSkip()")
      return .success
    }
    ui.load(URLRequest(url: roomURL))
  }

  // messages from the room page ("native") and from the YouTube page ("yt")
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any] else { return }
    if m.name == "native" {
      switch d["name"] as? String {
      case "load":
        if let a = d["arg"] as? [String: Any], let id = a["id"] as? String,
           let url = URL(string: "https://music.youtube.com/watch?v=\(id)") {
          pendingSeek = (a["ms"] as? Double) ?? 0
          yt.load(URLRequest(url: url))
        }
      case "seek":
        if let ms = d["arg"] as? Double { yt.evaluateJavaScript("window.bridge&&window.bridge.seek(\(ms))") }
      case "pause":
        yt.evaluateJavaScript("window.bridge&&window.bridge.pause()")
      default: break
      }
    } else if m.name == "yt" {
      switch d["k"] as? String {
      case "pos":
        if let v = d["v"] as? Double { ui.evaluateJavaScript("window.__pos=\(v)") }
      case "ended":
        ui.evaluateJavaScript("window.onYtmEnd&&window.onYtmEnd()")
      default: break
      }
    }
  }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    if w === yt && pendingSeek > 500 {
      let ms = pendingSeek; pendingSeek = 0
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        w.evaluateJavaScript("window.bridge&&window.bridge.seek(\(ms))")
      }
    }
  }

  // the room page may only navigate inside your Worker; everything else opens in Safari
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if w === ui, let host = a.request.url?.host, host != roomURL.host {
      if let url = a.request.url { UIApplication.shared.open(url) }
      decisionHandler(.cancel); return
    }
    decisionHandler(.allow)
  }

  // same bridge the Android app injects, with a shim so the page talks to Swift
  static let shim = #"""
  window.YtBridge={
    pos:function(ms){webkit.messageHandlers.yt.postMessage({k:'pos',v:ms})},
    ended:function(){webkit.messageHandlers.yt.postMessage({k:'ended'})},
    adSkipped:function(){}
  };
  """#

  static let adSkipJS = #"""
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
  """#
}
