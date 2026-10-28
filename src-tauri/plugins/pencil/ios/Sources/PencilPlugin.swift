// Apple Pencil for drawing on the iPad. A double-tap (and on a Pencil Pro, a
// squeeze) is sent to the page with the action the person chose for it in
// Settings > Apple Pencil, for the page to carry out; NeuroVue draws in a
// web view, so the system has no tool of its own to switch. `feedback` plays
// the Pencil Pro's haptics (iOS 17.5+); other pencils feel nothing.

import Tauri
import UIKit
import WebKit

struct FeedbackArgs: Decodable {
  /// "path" when a stroke is done, "alignment" when the tool changes.
  let kind: String
  /// Where, in the web view's points (the page's CSS pixels).
  let x: Double
  let y: Double
}

class PencilPlugin: Plugin, UIPencilInteractionDelegate {
  private weak var webview: WKWebView?
  /// A UICanvasFeedbackGenerator, which only exists from iOS 17.5.
  private var canvasFeedback: AnyObject?

  override func load(webview: WKWebView) {
    self.webview = webview
    DispatchQueue.main.async {
      let interaction = UIPencilInteraction()
      interaction.delegate = self
      webview.addInteraction(interaction)
      if #available(iOS 17.5, *) {
        self.canvasFeedback = UICanvasFeedbackGenerator(view: webview)
      }
    }
  }

  @objc public func feedback(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FeedbackArgs.self)
    DispatchQueue.main.async {
      if #available(iOS 17.5, *),
        let generator = self.canvasFeedback as? UICanvasFeedbackGenerator
      {
        let point = CGPoint(x: args.x, y: args.y)
        if args.kind == "alignment" {
          generator.alignmentOccurred(at: point)
        } else {
          generator.pathCompleted(at: point)
        }
      }
      invoke.resolve()
    }
  }

  // iOS 17.5 and later: a double-tap, and a Pencil Pro's squeeze once it's let
  // go. Where the pencil hovered, when it did, so the haptic can be felt there.
  @available(iOS 17.5, *)
  func pencilInteraction(
    _ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap
  ) {
    send("tap", UIPencilInteraction.preferredTapAction, at: tap.hoverPose?.location)
  }

  @available(iOS 17.5, *)
  func pencilInteraction(
    _ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze
  ) {
    guard squeeze.phase == .ended else { return }
    send("squeeze", UIPencilInteraction.preferredSqueezeAction, at: squeeze.hoverPose?.location)
  }

  // Before iOS 17.5: double-tap only.
  func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
    send("tap", UIPencilInteraction.preferredTapAction, at: nil)
  }

  private func send(_ gesture: String, _ action: UIPencilPreferredAction, at location: CGPoint?) {
    let bounds = webview?.bounds ?? .zero
    let point = location ?? CGPoint(x: bounds.midX, y: bounds.midY)
    let data: JSObject = ["action": name(of: action), "x": Double(point.x), "y": Double(point.y)]
    trigger(gesture, data: data)
  }

  private func name(of action: UIPencilPreferredAction) -> String {
    switch action {
    case .switchEraser: return "switchEraser"
    case .switchPrevious: return "switchPrevious"
    case .showColorPalette: return "showColorPalette"
    case .showInkAttributes: return "showInkAttributes"
    default:
      if #available(iOS 17.5, *) {
        if action == .showContextualPalette { return "showContextualPalette" }
        if action == .runSystemShortcut { return "runSystemShortcut" }
      }
      return "ignore"
    }
  }
}

@_cdecl("init_plugin_pencil")
func initPlugin() -> Plugin {
  return PencilPlugin()
}
