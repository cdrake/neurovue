import Foundation
import os
import QuickLookUI
import UniformTypeIdentifiers

private let log = Logger(subsystem: "org.neurovue.app.quicklook", category: "preview")

/// Finder's Space-bar preview: the three orthogonal mid-slices plus the header summary.
@objc(NVPreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let url = request.fileURL
        let image: NIfTIImage
        do {
            image = try NIfTIReader.read(url: url)
        } catch {
            // Also the decline path for .gz files that aren't NIfTI: Quick Look falls back
            // to its generic preview.
            log.info("no preview for \(url.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
            throw error
        }

        let slices = [View.axial, .coronal, .sagittal].compactMap { SliceRenderer.slice(image, view: $0) }
        let window = SliceRenderer.window(image.header, slices)
        // One mm scale for all three views so they line up; 2x pixels for Retina.
        let tallest = slices.map(\.extent.height).max() ?? 1
        let cssHeight = 300.0
        let mmToCSS = cssHeight / tallest

        var figures: [String] = []
        var attachments: [String: QLPreviewReplyAttachment] = [:]
        for slice in slices {
            let css = CGSize(width: slice.extent.width * mmToCSS, height: slice.extent.height * mmToCSS)
            guard let raw = SliceRenderer.cgImage(slice, window: window),
                  let scaled = SliceRenderer.resample(raw, to: CGSize(width: css.width * 2, height: css.height * 2)),
                  let png = SliceRenderer.png(scaled)
            else { continue }
            let name = "\(slice.view.title.lowercased()).png"
            attachments[name] = QLPreviewReplyAttachment(data: png, contentType: .png)
            figures.append("""
            <figure><img src="cid:\(name)" width="\(Int(css.width))" height="\(Int(css.height))" alt="">\
            <figcaption>\(slice.view.title)</figcaption></figure>
            """)
        }

        let html = PreviewPage.html(
            title: url.lastPathComponent, figures: figures,
            rows: PreviewPage.rows(image, window: window, url: url)
        )
        let width = max(720, slices.reduce(0) { $0 + $1.extent.width * mmToCSS } + 120)
        let reply = QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: width, height: 640)) { _ in
            Data(html.utf8)
        }
        reply.attachments = attachments
        reply.title = url.lastPathComponent
        log.debug("preview of \(url.lastPathComponent, privacy: .public): \(slices.count) views")
        return reply
    }
}

enum PreviewPage {
    static func rows(_ image: NIfTIImage, window: (lo: Float, hi: Float), url: URL) -> [(String, String)] {
        let h = image.header
        let n = h.shape
        var rows: [(String, String)] = []
        rows.append(("Format", "NIfTI-\(h.version)\(h.gzipped ? ", gzip-compressed" : "")"))
        var dims = "\(n[0]) × \(n[1]) × \(n[2])"
        if h.volumes > 1 { dims += " × \(h.volumes) volumes (showing the first)" }
        rows.append(("Dimensions", dims))
        let unit = ["", " m", " mm", " µm"][min(h.xyztUnits & 0x07, 3)]
        let spacing = h.spacing.map { format($0) }.joined(separator: " × ")
        rows.append(("Voxel size", spacing + (unit.isEmpty ? " (units unspecified)" : unit)))
        if h.volumes > 1, h.pixdim[4] > 0 {
            let timeUnit = [8: " s", 16: " ms", 24: " µs"][h.xyztUnits & 0x38] ?? ""
            rows.append(("Repetition time", format(h.pixdim[4]) + timeUnit))
        }
        rows.append(("Data type", NIfTIHeader.datatypeNames[h.datatype] ?? "code \(h.datatype)"))
        let space = h.sformCode > 0 ? h.sformCode : h.qformCode
        let spaceName = [1: "scanner", 2: "aligned", 3: "Talairach", 4: "MNI 152", 5: "template"][space]
        let source = h.sformCode > 0 ? "sform" : h.qformCode > 0 ? "qform" : "no transform; pixdim only"
        rows.append(("Orientation", "\(image.orientation.code) (\(source)\(spaceName.map { ", \($0) space" } ?? ""))"))
        rows.append(("Display window", "\(format(Double(window.lo))) to \(format(Double(window.hi)))"))
        if !h.descrip.isEmpty { rows.append(("Description", h.descrip)) }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
            rows.append(("File size", ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)))
        }
        return rows
    }

    static func format(_ v: Double) -> String {
        if v == v.rounded(), abs(v) < 1e9 { return String(Int(v)) }
        return String(format: abs(v) >= 100 ? "%.1f" : "%.3g", v)
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func html(title: String, figures: [String], rows: [(String, String)]) -> String {
        let table = rows.map { "<tr><th>\(escape($0.0))</th><td>\(escape($0.1))</td></tr>" }.joined()
        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        :root { color-scheme: light dark; --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; }
        @media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; } }
        body { margin: 0; padding: 20px 24px; background: var(--bg); color: var(--fg);
               font: 13px -apple-system, system-ui, sans-serif; }
        h1 { font-size: 15px; font-weight: 600; margin: 0 0 16px; overflow-wrap: anywhere; }
        .views { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 18px; }
        figure { margin: 0; }
        img { display: block; background: #000; border-radius: 4px; }
        figcaption { color: var(--muted); font-size: 11px; margin-top: 4px; text-align: center; }
        table { border-collapse: collapse; }
        th { text-align: left; font-weight: 500; color: var(--muted); padding: 3px 16px 3px 0; vertical-align: top; }
        td { padding: 3px 0; overflow-wrap: anywhere; }
        tr + tr th, tr + tr td { border-top: 1px solid var(--line); }
        </style></head><body>
        <h1>\(escape(title))</h1>
        <div class="views">\(figures.joined())</div>
        <table>\(table)</table>
        </body></html>
        """
    }
}
