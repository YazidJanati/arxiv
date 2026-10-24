import AppKit
let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("AppIcon.iconset")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        NSColor(calibratedWhite: 0.105, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: pixels, height: pixels).insetBy(dx: CGFloat(pixels) * 0.04, dy: CGFloat(pixels) * 0.04), xRadius: CGFloat(pixels) * 0.2, yRadius: CGFloat(pixels) * 0.2).fill()
        let text = "arχiv" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: CGFloat(pixels) * 0.225, weight: .regular), .foregroundColor: NSColor(calibratedWhite: 0.8, alpha: 1)]
        let bounds = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: (CGFloat(pixels) - bounds.width) / 2, y: (CGFloat(pixels) - bounds.height) / 2), withAttributes: attributes)
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let data = bitmap.representation(using: .png, properties: [:])!
        let suffix = scale == 2 ? "@2x" : ""
        try data.write(to: root.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
