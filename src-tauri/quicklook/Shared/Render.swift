import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Turns NIfTI mid-planes into upright grayscale images in NeuroVue's (and NiiVue's)
// default convention: patient right on screen right, anterior/superior up, and the
// nose pointing right in sagittal views.

enum View: Int, CaseIterable {
    case sagittal = 0, coronal = 1, axial = 2

    var title: String {
        switch self {
        case .axial: return "Axial"
        case .coronal: return "Coronal"
        case .sagittal: return "Sagittal"
        }
    }

    /// World axes (0 = R, 1 = A, 2 = S) that run along screen x and up screen y.
    var screenAxes: (x: Int, y: Int) {
        switch self {
        case .axial: return (0, 1)
        case .coronal: return (0, 2)
        case .sagittal: return (1, 2)
        }
    }
}

struct SliceImage {
    let view: View
    let width: Int
    let height: Int
    /// Physical size of the slice in voxel-spacing units (mm for most files).
    let extent: CGSize
    /// Row-major from the top-left, NaN where the data is not finite.
    let values: [Float]
}

enum SliceRenderer {
    static func slice(_ image: NIfTIImage, view: View) -> SliceImage? {
        let o = image.orientation
        guard let plane = image.planes[o.voxelAxis(forWorld: view.rawValue)] else { return nil }
        let hAxis = o.voxelAxis(forWorld: view.screenAxes.x)
        let vAxis = o.voxelAxis(forWorld: view.screenAxes.y)
        let n = image.header.shape
        let (w, h) = (n[hAxis], n[vAxis])
        let hIsU = plane.axes.u == hAxis
        var out = [Float](repeating: .nan, count: w * h)
        for y in 0..<h {
            // Top row is the most anterior/superior voxel.
            let iv = o.flipped[vAxis] ? y : h - 1 - y
            for x in 0..<w {
                let ih = o.flipped[hAxis] ? w - 1 - x : x
                let (u, v) = hIsU ? (ih, iv) : (iv, ih)
                out[y * w + x] = plane.values[u + v * plane.size.u]
            }
        }
        let spacing = image.header.spacing
        return SliceImage(
            view: view, width: w, height: h,
            extent: CGSize(width: Double(w) * spacing[hAxis], height: Double(h) * spacing[vAxis]),
            values: out
        )
    }

    /// Display window: cal_min/cal_max when the header sets them, otherwise the 2nd–98th
    /// percentile of the non-zero voxels (zero is usually background).
    static func window(_ header: NIfTIHeader, _ slices: [SliceImage]) -> (lo: Float, hi: Float) {
        if header.calMax > header.calMin, header.calMin.isFinite, header.calMax.isFinite {
            return (Float(header.calMin), Float(header.calMax))
        }
        let total = slices.reduce(0) { $0 + $1.values.count }
        let stride = max(total / 200_000, 1)
        var sample: [Float] = []
        var all: [Float] = []
        var index = 0
        for slice in slices {
            for v in slice.values where v.isFinite {
                if index % stride == 0 {
                    all.append(v)
                    if v != 0 { sample.append(v) }
                }
                index += 1
            }
        }
        if sample.isEmpty { sample = all }
        guard !sample.isEmpty else { return (0, 1) }
        sample.sort()
        let (first, last) = (sample.first!, sample.last!)
        // Non-negative data (anatomy) starts at 0 so the background stays black.
        let lo = first >= 0 ? 0 : sample[Int(Double(sample.count - 1) * 0.02)]
        let hi = sample[Int(Double(sample.count - 1) * 0.98)]
        if hi > lo { return (lo, hi) }
        return (first, last > first ? last : first + 1)
    }

    static func cgImage(_ slice: SliceImage, window: (lo: Float, hi: Float)) -> CGImage? {
        let scale = 255 / max(window.hi - window.lo, .leastNonzeroMagnitude)
        var pixels = [UInt8](repeating: 0, count: slice.width * slice.height)
        for i in pixels.indices {
            let v = slice.values[i]
            guard v.isFinite else { continue }
            pixels[i] = UInt8(max(0, min(255, (v - window.lo) * scale)))
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: slice.width, height: slice.height, bitsPerComponent: 8, bitsPerPixel: 8,
            bytesPerRow: slice.width, space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
        )
    }

    /// Redraws `image` at `size` pixels so non-square voxels come out at the right aspect.
    static func resample(_ image: CGImage, to size: CGSize) -> CGImage? {
        let w = max(Int(size.width.rounded()), 1)
        let h = max(Int(size.height.rounded()), 1)
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }
}
