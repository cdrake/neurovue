import Foundation

// FreeSurfer .mgh/.mgz header, mapped onto NIfTIHeader so the NIfTI slice and render
// code is reused as is. Layout (big-endian): version, width, height, depth, nframes,
// type, dof (int32), goodRASFlag (int16), voxel sizes (3 floats), Mdc (9 floats,
// columns x/y/z in RAS), c_ras (3 floats). Voxels start at byte 284.
enum MGH {
    static let dataOffset = 284
    static let usedBytes = 90
    /// MRI_UCHAR, MRI_INT, MRI_FLOAT, MRI_SHORT -> NIfTI uint8, int32, float32, int16.
    static let datatypes: [Int: Int] = [0: 2, 1: 8, 3: 16, 4: 4]

    static func readHeader(_ source: ByteSource) throws -> NIfTIHeader {
        var bytes = [UInt8](repeating: 0, count: usedBytes)
        let got = try bytes.withUnsafeMutableBytes { try source.read($0) }
        guard got == usedBytes else { throw NIfTIError.notNIfTI }
        let r = HeaderBytes(bytes: bytes, swapped: Int32(1).bigEndian != 1)
        let dims = (1...4).map { Int(r.int32(4 * $0)) }
        guard r.int32(0) == 1, dims.allSatisfy({ $0 > 0 }) else { throw NIfTIError.notNIfTI }
        let type = Int(r.int32(20))

        var h = NIfTIHeader()
        h.format = "MGH"
        h.headerSize = usedBytes
        h.voxOffset = dataOffset
        h.swapped = r.swapped
        h.gzipped = source is GzipSource
        h.datatype = datatypes[type] ?? -type // unknown types reach unsupportedDatatype
        h.dim = [dims[3] > 1 ? 4 : 3] + dims + [1, 1, 1]
        h.xyztUnits = 2 // mm

        // Without goodRAS, FreeSurfer assumes 1 mm coronal: x -> L, y -> I, z -> A.
        var size = [1.0, 1.0, 1.0]
        var columns: [[Double]] = [[-1, 0, 0], [0, 0, -1], [0, 1, 0]]
        var center = [0.0, 0.0, 0.0]
        if r.int16(28) > 0 {
            size = (0..<3).map { Double(r.float32(30 + 4 * $0)) }
            columns = (0..<3).map { c in (0..<3).map { Double(r.float32(42 + 12 * c + 4 * $0)) } }
            center = (0..<3).map { Double(r.float32(78 + 4 * $0)) }
        }
        h.pixdim = [1] + size + [0, 1, 1, 1] // TR is in an optional trailer; leave unset
        // vox2ras: M = Mdc * diag(size); P0 = c_ras - M * (dims / 2).
        h.srow = (0..<3).map { row in
            let m = (0..<3).map { columns[$0][row] * size[$0] }
            let p0 = center[row] - (0..<3).reduce(0) { $0 + m[$1] * Double(dims[$1]) / 2 }
            return m + [p0]
        }
        h.sformCode = 1
        return h
    }
}
