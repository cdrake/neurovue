import Foundation
import zlib

// Streaming NIfTI-1/NIfTI-2 reader for Quick Look. It decodes only the first
// volume and keeps only the three mid-planes, so memory stays bounded no matter
// how large (or how many volumes) the file has. Gzip is inflated on the fly.

enum NIfTIError: Error, CustomStringConvertible {
    case notNIfTI
    case headerImagePair
    case unsupportedDatatype(Int)
    case tooLarge
    case truncated
    case io(String)

    var description: String {
        switch self {
        case .notNIfTI: return "not a NIfTI file"
        case .headerImagePair: return "NIfTI header/image pairs (.hdr/.img) are not supported"
        case let .unsupportedDatatype(code): return "unsupported NIfTI datatype \(code)"
        case .tooLarge: return "image planes are too large to preview"
        case .truncated: return "file ends before the image data"
        case let .io(message): return message
        }
    }
}

struct NIfTIHeader {
    var version = 1
    var gzipped = false
    /// Written on a machine of the other byte order; applies to voxels too.
    var swapped = false
    var dim = [Int](repeating: 1, count: 8)
    var datatype = 0
    var pixdim = [Double](repeating: 1, count: 8)
    var voxOffset = 0
    var sclSlope = 0.0
    var sclInter = 0.0
    var calMin = 0.0
    var calMax = 0.0
    var descrip = ""
    var xyztUnits = 0
    var qformCode = 0
    var sformCode = 0
    var quatern = (b: 0.0, c: 0.0, d: 0.0)
    var srow = [[Double]](repeating: [0, 0, 0, 0], count: 3)

    /// Size along each of the three spatial voxel axes (at least 1).
    var shape: [Int] { (1...3).map { $0 <= dim[0] ? max(dim[$0], 1) : 1 } }

    /// Number of 3D volumes (product of dims 4...7).
    var volumes: Int {
        dim[0] < 4 ? 1 : (4...min(dim[0], 7)).reduce(1) { $0 * max(dim[$1], 1) }
    }

    /// Physical voxel size along each spatial axis (falls back to 1).
    var spacing: [Double] {
        (1...3).map { abs(pixdim[$0]).isFinite && pixdim[$0] != 0 ? abs(pixdim[$0]) : 1 }
    }

    var bytesPerVoxel: Int? { NIfTIHeader.bytesPerVoxel[datatype] }

    static let bytesPerVoxel: [Int: Int] = [
        2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 128: 3, 256: 1, 512: 2, 768: 4, 1024: 8, 1280: 8,
        2304: 4,
    ]

    static let datatypeNames: [Int: String] = [
        2: "uint8", 4: "int16", 8: "int32", 16: "float32", 32: "complex64", 64: "float64",
        128: "RGB24", 256: "int8", 512: "uint16", 768: "uint32", 1024: "int64", 1280: "uint64",
        1536: "float128", 1792: "complex128", 2048: "complex256", 2304: "RGBA32",
    ]

    /// 3x3 voxel-to-world direction matrix (rows: world x/y/z, columns: voxel i/j/k).
    var direction: [[Double]] {
        if sformCode > 0 {
            return srow.map { Array($0.prefix(3)) }
        }
        let s = spacing
        guard qformCode > 0 else {
            return [[s[0], 0, 0], [0, s[1], 0], [0, 0, s[2]]]
        }
        let (b, c, d) = quatern
        let a = sqrt(max(0, 1 - (b * b + c * c + d * d)))
        let r: [[Double]] = [
            [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
            [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
            [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
        ]
        let qfac = pixdim[0] < 0 ? -1.0 : 1.0
        let scale = [s[0], s[1], s[2] * qfac]
        return r.map { row in (0..<3).map { row[$0] * scale[$0] } }
    }
}

/// How each voxel axis maps to the closest world (RAS) axis.
struct Orientation {
    /// worldAxis[voxelAxis] = 0 (R/L), 1 (A/P) or 2 (S/I).
    let worldAxis: [Int]
    /// True when increasing the voxel index moves toward L, P or I.
    let flipped: [Bool]

    init(_ header: NIfTIHeader) {
        let m = header.direction
        let permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
        func column(_ j: Int) -> [Double] { (0..<3).map { m[$0][j] } }
        func norm(_ v: [Double]) -> Double { max(sqrt(v.reduce(0) { $0 + $1 * $1 }), 1e-12) }
        let best = permutations.max { lhs, rhs in
            func score(_ p: [Int]) -> Double {
                (0..<3).reduce(0) { $0 + abs(m[p[$1]][$1]) / norm(column($1)) }
            }
            return score(lhs) < score(rhs)
        }!
        worldAxis = best
        flipped = (0..<3).map { m[best[$0]][$0] < 0 }
    }

    func voxelAxis(forWorld world: Int) -> Int { worldAxis.firstIndex(of: world)! }

    /// e.g. "RAS" or "LPI": the direction each voxel axis increases toward.
    var code: String {
        let letters = [["R", "L"], ["A", "P"], ["S", "I"]]
        return (0..<3).map { letters[worldAxis[$0]][flipped[$0] ? 1 : 0] }.joined()
    }
}

/// A 2D slice through the first volume, perpendicular to one voxel axis.
/// Values are stored row-major over the two remaining voxel axes (lower axis fastest).
struct Plane {
    let fixedAxis: Int
    let axes: (u: Int, v: Int)
    let size: (u: Int, v: Int)
    var values: [Float]
}

struct NIfTIImage {
    let header: NIfTIHeader
    let orientation: Orientation
    /// Mid-planes, indexed by the voxel axis they are perpendicular to; nil when not requested.
    let planes: [Plane?]
}

enum NIfTIReader {
    static let maxPlanePixels = 4096 * 4096

    /// Reads the header and the mid-planes perpendicular to `world` axes (0 = sagittal,
    /// 1 = coronal, 2 = axial) of the first volume.
    static func read(url: URL, world: Set<Int> = [0, 1, 2]) throws -> NIfTIImage {
        let source = try openSource(url: url)
        let header = try readHeader(source)
        guard let bpv = header.bytesPerVoxel else {
            throw NIfTIError.unsupportedDatatype(header.datatype)
        }
        let orientation = Orientation(header)
        let wanted = Set(world.map { orientation.voxelAxis(forWorld: $0) })
        let n = header.shape
        for axis in wanted {
            let others = (0..<3).filter { $0 != axis }
            guard n[others[0]] * n[others[1]] <= maxPlanePixels else { throw NIfTIError.tooLarge }
        }
        guard n[0] <= maxPlanePixels else { throw NIfTIError.tooLarge }

        let headerBytes = header.version == 1 ? 348 : 540
        try source.skip(max(header.voxOffset - headerBytes, 0))

        let mid = n.map { $0 / 2 }
        var p0 = wanted.contains(0) ? [Float](repeating: 0, count: n[1] * n[2]) : []
        var p1 = wanted.contains(1) ? [Float](repeating: 0, count: n[0] * n[2]) : []
        var p2 = wanted.contains(2) ? [Float](repeating: 0, count: n[0] * n[1]) : []
        // The last row (j, k) we need to read: planes 0 and 1 span every k, plane 2 ends at mid.
        let lastK = wanted.contains(0) || wanted.contains(1) ? n[2] - 1 : mid[2]

        let rowBytes = n[0] * bpv
        var raw = [UInt8](repeating: 0, count: rowBytes)
        var row = [Float](repeating: 0, count: n[0])
        let convert = Converter(header: header)

        rows: for k in 0...lastK {
            for j in 0..<n[1] {
                let got = try raw.withUnsafeMutableBytes { try source.read($0) }
                guard got == rowBytes else { throw NIfTIError.truncated }
                let wholeRow = (!p2.isEmpty && k == mid[2]) || (!p1.isEmpty && j == mid[1])
                raw.withUnsafeBytes { src in
                    row.withUnsafeMutableBufferPointer { dst in
                        if wholeRow {
                            convert(src.baseAddress!, 0, n[0], dst.baseAddress!)
                        } else if !p0.isEmpty {
                            convert(src.baseAddress!, mid[0], 1, dst.baseAddress! + mid[0])
                        }
                    }
                }
                if !p0.isEmpty { p0[j + k * n[1]] = row[mid[0]] }
                if !p1.isEmpty, j == mid[1] { p1.replaceSubrange(k * n[0]..<(k + 1) * n[0], with: row) }
                if !p2.isEmpty, k == mid[2] { p2.replaceSubrange(j * n[0]..<(j + 1) * n[0], with: row) }
                if k == lastK, j == n[1] - 1 { break rows }
            }
        }

        let planes: [Plane?] = [
            p0.isEmpty ? nil : Plane(fixedAxis: 0, axes: (1, 2), size: (n[1], n[2]), values: p0),
            p1.isEmpty ? nil : Plane(fixedAxis: 1, axes: (0, 2), size: (n[0], n[2]), values: p1),
            p2.isEmpty ? nil : Plane(fixedAxis: 2, axes: (0, 1), size: (n[0], n[1]), values: p2),
        ]
        return NIfTIImage(header: header, orientation: orientation, planes: planes)
    }

    static func openSource(url: URL) throws -> ByteSource {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw NIfTIError.io("cannot open \(url.lastPathComponent): \(error.localizedDescription)")
        }
        let magic = (try? handle.read(upToCount: 2)) ?? Data()
        try handle.seek(toOffset: 0)
        if magic.count == 2, magic[magic.startIndex] == 0x1F, magic[magic.startIndex + 1] == 0x8B {
            return try GzipSource(handle: handle)
        }
        return FileSource(handle: handle)
    }

    static func readHeader(_ source: ByteSource) throws -> NIfTIHeader {
        var bytes = [UInt8](repeating: 0, count: 540)
        let first = try bytes.withUnsafeMutableBytes { try source.read(UnsafeMutableRawBufferPointer(rebasing: $0[0..<4])) }
        guard first == 4 else { throw NIfTIError.notNIfTI }
        let sizeofHdr = bytes.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let (version, swapped): (Int, Bool)
        switch sizeofHdr {
        case 348: (version, swapped) = (1, false)
        case UInt32(348).byteSwapped: (version, swapped) = (1, true)
        case 540: (version, swapped) = (2, false)
        case UInt32(540).byteSwapped: (version, swapped) = (2, true)
        default: throw NIfTIError.notNIfTI
        }
        let total = version == 1 ? 348 : 540
        let rest = try bytes.withUnsafeMutableBytes {
            try source.read(UnsafeMutableRawBufferPointer(rebasing: $0[4..<total]))
        }
        guard rest == total - 4 else { throw NIfTIError.notNIfTI }

        let r = HeaderBytes(bytes: bytes, swapped: swapped)
        var h = NIfTIHeader()
        h.version = version
        h.swapped = swapped
        h.gzipped = source is GzipSource
        if version == 1 {
            let magic = r.string(344, 4)
            if magic == "ni1" { throw NIfTIError.headerImagePair }
            guard magic == "n+1" else { throw NIfTIError.notNIfTI }
            h.dim = (0..<8).map { Int(r.int16(40 + 2 * $0)) }
            h.datatype = Int(r.int16(70))
            h.pixdim = (0..<8).map { Double(r.float32(76 + 4 * $0)) }
            h.voxOffset = Int(r.float32(108))
            h.sclSlope = Double(r.float32(112))
            h.sclInter = Double(r.float32(116))
            h.calMax = Double(r.float32(124))
            h.calMin = Double(r.float32(128))
            h.xyztUnits = Int(bytes[123])
            h.descrip = r.string(148, 80)
            h.qformCode = Int(r.int16(252))
            h.sformCode = Int(r.int16(254))
            h.quatern = (Double(r.float32(256)), Double(r.float32(260)), Double(r.float32(264)))
            h.srow = (0..<3).map { row in (0..<4).map { Double(r.float32(280 + 16 * row + 4 * $0)) } }
        } else {
            guard r.string(4, 3) == "n+2" else {
                throw r.string(4, 3) == "ni2" ? NIfTIError.headerImagePair : NIfTIError.notNIfTI
            }
            h.datatype = Int(r.int16(12))
            h.dim = (0..<8).map { Int(r.int64(16 + 8 * $0)) }
            h.pixdim = (0..<8).map { r.float64(104 + 8 * $0) }
            h.voxOffset = Int(r.int64(168))
            h.sclSlope = r.float64(176)
            h.sclInter = r.float64(184)
            h.calMax = r.float64(192)
            h.calMin = r.float64(200)
            h.descrip = r.string(240, 80)
            h.qformCode = Int(r.int32(344))
            h.sformCode = Int(r.int32(348))
            h.quatern = (r.float64(352), r.float64(360), r.float64(368))
            h.srow = (0..<3).map { row in (0..<4).map { r.float64(400 + 32 * row + 8 * $0) } }
            h.xyztUnits = Int(r.int32(500))
        }
        guard (1...7).contains(h.dim[0]) else { throw NIfTIError.notNIfTI }
        return h
    }
}

private struct HeaderBytes {
    let bytes: [UInt8]
    let swapped: Bool

    func load<T: FixedWidthInteger>(_ offset: Int, _: T.Type) -> T {
        let v = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: T.self) }
        return swapped ? v.byteSwapped : v
    }

    func int16(_ o: Int) -> Int16 { load(o, Int16.self) }
    func int32(_ o: Int) -> Int32 { load(o, Int32.self) }
    func int64(_ o: Int) -> Int64 { load(o, Int64.self) }
    func float32(_ o: Int) -> Float { Float(bitPattern: load(o, UInt32.self)) }
    func float64(_ o: Int) -> Double { Double(bitPattern: load(o, UInt64.self)) }

    func string(_ offset: Int, _ length: Int) -> String {
        let slice = bytes[offset..<offset + length].prefix { $0 != 0 }
        return String(decoding: slice, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Converts raw voxels to Float, applying byte order and scl_slope/scl_inter.
private struct Converter {
    let datatype: Int
    let bpv: Int
    let swapped: Bool
    let slope: Float
    let inter: Float

    init(header: NIfTIHeader) {
        datatype = header.datatype
        bpv = header.bytesPerVoxel ?? 1
        swapped = header.swapped
        let s = Float(header.sclSlope)
        let usable = s.isFinite && s != 0
        slope = usable ? s : 1
        inter = usable && header.sclInter.isFinite ? Float(header.sclInter) : 0
    }

    func callAsFunction(_ src: UnsafeRawPointer, _ start: Int, _ count: Int, _ dst: UnsafeMutablePointer<Float>) {
        func ints<T: FixedWidthInteger>(_: T.Type) {
            for i in 0..<count {
                var v = src.loadUnaligned(fromByteOffset: (start + i) * bpv, as: T.self)
                if swapped { v = v.byteSwapped }
                dst[i] = Float(v)
            }
        }
        switch datatype {
        case 2: ints(UInt8.self)
        case 256: ints(Int8.self)
        case 4: ints(Int16.self)
        case 512: ints(UInt16.self)
        case 8: ints(Int32.self)
        case 768: ints(UInt32.self)
        case 1024: ints(Int64.self)
        case 1280: ints(UInt64.self)
        case 16:
            for i in 0..<count {
                var v = src.loadUnaligned(fromByteOffset: (start + i) * 4, as: UInt32.self)
                if swapped { v = v.byteSwapped }
                dst[i] = Float(bitPattern: v)
            }
        case 64:
            for i in 0..<count {
                var v = src.loadUnaligned(fromByteOffset: (start + i) * 8, as: UInt64.self)
                if swapped { v = v.byteSwapped }
                dst[i] = Float(Double(bitPattern: v))
            }
        case 128, 2304:
            // RGB(A): show luminance.
            for i in 0..<count {
                let p = src + (start + i) * bpv
                let r = Float(p.load(as: UInt8.self))
                let g = Float(p.load(fromByteOffset: 1, as: UInt8.self))
                let b = Float(p.load(fromByteOffset: 2, as: UInt8.self))
                dst[i] = 0.299 * r + 0.587 * g + 0.114 * b
            }
            return
        default:
            return
        }
        if slope != 1 || inter != 0 {
            for i in 0..<count { dst[i] = dst[i] * slope + inter }
        }
    }
}

// MARK: - Byte sources

protocol ByteSource: AnyObject {
    /// Fills `buffer` and returns its size, or fewer bytes only at end of data.
    func read(_ buffer: UnsafeMutableRawBufferPointer) throws -> Int
}

extension ByteSource {
    func skip(_ count: Int) throws {
        var remaining = count
        var scratch = [UInt8](repeating: 0, count: min(max(count, 1), 1 << 16))
        while remaining > 0 {
            let chunk = min(remaining, scratch.count)
            let got = try scratch.withUnsafeMutableBytes {
                try read(UnsafeMutableRawBufferPointer(rebasing: $0[0..<chunk]))
            }
            guard got == chunk else { throw NIfTIError.truncated }
            remaining -= chunk
        }
    }
}

final class FileSource: ByteSource {
    private let handle: FileHandle

    init(handle: FileHandle) { self.handle = handle }

    deinit { try? handle.close() }

    func read(_ buffer: UnsafeMutableRawBufferPointer) throws -> Int {
        var filled = 0
        while filled < buffer.count {
            guard let data = try handle.read(upToCount: buffer.count - filled), !data.isEmpty else { break }
            data.copyBytes(to: UnsafeMutableRawBufferPointer(rebasing: buffer[filled...]))
            filled += data.count
        }
        return filled
    }
}

final class GzipSource: ByteSource {
    private let handle: FileHandle
    private var stream = z_stream()
    private let input: UnsafeMutablePointer<UInt8>
    private let inputSize = 1 << 18
    private var inputEOF = false
    private var finished = false

    init(handle: FileHandle) throws {
        self.handle = handle
        input = .allocate(capacity: inputSize)
        // 15 + 32: maximum window, auto-detect the gzip (or zlib) wrapper.
        let status = inflateInit2_(&stream, 15 + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else {
            input.deallocate()
            throw NIfTIError.io("zlib init failed (\(status))")
        }
    }

    deinit {
        inflateEnd(&stream)
        input.deallocate()
        try? handle.close()
    }

    private func refill() throws {
        guard !inputEOF else { return }
        guard let data = try handle.read(upToCount: inputSize), !data.isEmpty else {
            inputEOF = true
            return
        }
        data.copyBytes(to: input, count: data.count)
        stream.next_in = input
        stream.avail_in = uInt(data.count)
    }

    func read(_ buffer: UnsafeMutableRawBufferPointer) throws -> Int {
        guard let base = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        var produced = 0
        while produced < buffer.count, !finished {
            if stream.avail_in == 0 {
                try refill()
                if stream.avail_in == 0 { break }
            }
            stream.next_out = base + produced
            stream.avail_out = uInt(buffer.count - produced)
            let status = inflate(&stream, Z_NO_FLUSH)
            produced = buffer.count - Int(stream.avail_out)
            switch status {
            case Z_OK, Z_BUF_ERROR:
                continue
            case Z_STREAM_END:
                // Concatenated gzip members are valid gzip; keep going if more follow.
                if stream.avail_in == 0 { try refill() }
                if stream.avail_in > 0 { inflateReset(&stream) } else { finished = true }
            default:
                throw NIfTIError.io("corrupt gzip data (\(status))")
            }
        }
        return produced
    }
}
