import AppKit
let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("AppIcon.iconset")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        // Render exact pixel dimensions independently of the display's Retina scale.
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
        NSColor(calibratedWhite: 0.105, alpha: 1).setFill()
        // Keep a 10% transparent margin so the tile matches other Dock icons.
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: pixels, height: pixels).insetBy(dx: CGFloat(pixels) * 0.1, dy: CGFloat(pixels) * 0.1), xRadius: CGFloat(pixels) * 0.174, yRadius: CGFloat(pixels) * 0.174).fill()
        let text = "arχiv" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: CGFloat(pixels) * 0.196, weight: .regular), .foregroundColor: NSColor(calibratedWhite: 0.8, alpha: 1)]
        let bounds = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: (CGFloat(pixels) - bounds.width) / 2, y: (CGFloat(pixels) - bounds.height) / 2), withAttributes: attributes)
        NSGraphicsContext.restoreGraphicsState()
        let data = bitmap.representation(using: .png, properties: [:])!
        let suffix = scale == 2 ? "@2x" : ""
        try data.write(to: root.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
