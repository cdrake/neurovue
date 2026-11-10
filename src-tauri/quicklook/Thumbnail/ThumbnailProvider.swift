import Foundation
import os
import QuickLookThumbnailing

private let log = Logger(subsystem: "org.neurovue.app.quicklook", category: "thumbnail")

/// Finder icon: the axial mid-slice of the first volume.
@objc(NVThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(
        for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let url = request.fileURL
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
            log.info("no thumbnail for \(url.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
            handler(nil, error)
        }
    }
}
