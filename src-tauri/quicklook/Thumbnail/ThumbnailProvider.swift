import Foundation
import os
import ImageIO
import QuickLookThumbnailing

private let log = Logger(subsystem: "org.neurovue.app.quicklook", category: "thumbnail")

/// Finder icon: the axial mid-slice of the first volume.
@objc(NVThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(
        for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let url = request.fileURL
        if url.pathExtension == "nvb" {
            return handler(bundleReply(url, request), nil)
        }
        do {
            let image = try NIfTIReader.read(url: url, world: [2])
            guard let slice = SliceRenderer.slice(image, view: .axial),
                  let cg = SliceRenderer.cgImage(slice, window: SliceRenderer.window(image.header, [slice]))
            else { throw NIfTIError.notNIfTI }

            let max = request.maximumSize
            let fit = min(max.width / slice.extent.width, max.height / slice.extent.height)
            let size = CGSize(width: slice.extent.width * fit, height: slice.extent.height * fit)
            let reply = QLThumbnailReply(contextSize: size) { ctx in
                ctx.interpolationQuality = .high
                ctx.draw(cg, in: CGRect(origin: .zero, size: size))
                return true
            }
            reply.extensionBadge = "NIfTI"
            handler(reply, nil)
        } catch {
            log.info("no thumbnail for \(url.lastPathComponent, privacy: .private): \(String(describing: error), privacy: .private)")
            handler(nil, error)
        }
    }

    /// The start view's saved picture; nil (the generic icon) without one.
    private func bundleReply(_ url: URL, _ request: QLFileThumbnailRequest) -> QLThumbnailReply? {
        guard let png = try? NVBundleThumbnail.png(url: url),
              let source = CGImageSourceCreateWithData(png as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        let max = request.maximumSize
        let fit = min(max.width / CGFloat(cg.width), max.height / CGFloat(cg.height))
        let size = CGSize(width: CGFloat(cg.width) * fit, height: CGFloat(cg.height) * fit)
        let reply = QLThumbnailReply(contextSize: size) { ctx in
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(origin: .zero, size: size))
            return true
        }
        reply.extensionBadge = "NeuroVue"
        return reply
    }
}
