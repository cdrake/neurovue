import Foundation

/// A `.nvbundle` (a Stored zip): its start view's PNG thumbnail, which the
/// writer puts right after `mimetype` without zip64 extras (`write_bundle_zip`).
/// Reads only those two local headers, never the volumes behind them.
enum NVBundleThumbnail {
    static func png(url: URL) throws -> Data {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        var offset: UInt64 = 0
        for index in 0..<2 {
            try file.seek(toOffset: offset)
            guard let header = try file.read(upToCount: 30), header.count == 30,
                  header.le32(0) == 0x0403_4b50, header.le16(8) == 0 // Stored
            else { throw NIfTIError.notNIfTI }
            let size = UInt64(header.le32(18))
            let nameLength = Int(header.le16(26))
            let extraLength = UInt64(header.le16(28))
            guard let name = try file.read(upToCount: nameLength).flatMap({ String(data: $0, encoding: .utf8) })
            else { throw NIfTIError.truncated }
            let data = offset + 30 + UInt64(nameLength) + extraLength
            if index == 1 {
                // An absent thumbnail, or one too big to be ours.
                guard name.hasPrefix("thumbs/"), size < 16 << 20 else { throw NIfTIError.notNIfTI }
                try file.seek(toOffset: data)
                guard let png = try file.read(upToCount: Int(size)), png.count == Int(size)
                else { throw NIfTIError.truncated }
                return png
            }
            guard name == "mimetype" else { throw NIfTIError.notNIfTI }
            offset = data + size
        }
        throw NIfTIError.notNIfTI
    }
}

private extension Data {
    func le16(_ at: Int) -> UInt16 { UInt16(self[startIndex + at]) | UInt16(self[startIndex + at + 1]) << 8 }
    func le32(_ at: Int) -> UInt32 { UInt32(le16(at)) | UInt32(le16(at + 2)) << 16 }
}
