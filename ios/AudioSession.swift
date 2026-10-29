import AVFoundation
import UIKit
import WebKit

// Info.plist: UIBackgroundModes = ["audio"]  (Expo: app.json -> ios.infoPlist.UIBackgroundModes)
// WKWebViewConfiguration: allowsInlineMediaPlayback = true, mediaTypesRequiringUserActionForPlayback = []
func configure() {
  let s = AVAudioSession.sharedInstance()
  try? s.setCategory(.playback, mode: .default, options: [])
  try? s.setActive(true)
  UIApplication.shared.beginReceivingRemoteControlEvents()
}

// same patterns as the Android interceptor
let adRules = #"""
[
 {"trigger":{"url-filter":".*doubleclick\\.net.*"},"action":{"type":"block"}},
 {"trigger":{"url-filter":".*googlesyndication.*"},"action":{"type":"block"}},
 {"trigger":{"url-filter":".*/pagead/.*"},"action":{"type":"block"}},
 {"trigger":{"url-filter":".*googleads\\.g\\.doubleclick.*"},"action":{"type":"block"}}
]
"""#

func installAdBlock(_ ucc: WKUserContentController, done: @escaping () -> Void) {
  WKContentRuleListStore.default().compileContentRuleList(
    forIdentifier: "ads", encodedContentRuleList: adRules) { list, _ in
    if let l = list { ucc.add(l) }
    done()
  }
}
