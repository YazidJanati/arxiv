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
        // Terminal-style gray frame, with the same 10% Dock padding.
        let unit = CGFloat(pixels)
        let tile = NSRect(x: 0, y: 0, width: unit, height: unit).insetBy(dx: unit * 0.1, dy: unit * 0.1)
        let frame = NSBezierPath(roundedRect: tile, xRadius: unit * 0.19, yRadius: unit * 0.19)
        NSGradient(starting: NSColor(calibratedWhite: 0.43, alpha: 1), ending: NSColor(calibratedRed: 0.81, green: 0.87, blue: 0.89, alpha: 1))!.draw(in: frame, angle: 90)
        NSColor(calibratedWhite: 0.025, alpha: 1).setFill()
        NSBezierPath(roundedRect: tile.insetBy(dx: unit * 0.032, dy: unit * 0.032), xRadius: unit * 0.158, yRadius: unit * 0.158).fill()
        NSColor(calibratedWhite: 0.105, alpha: 1).setFill()
        NSBezierPath(roundedRect: tile.insetBy(dx: unit * 0.09, dy: unit * 0.09), xRadius: unit * 0.1, yRadius: unit * 0.1).fill()
        let text = "arχiv" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: CGFloat(pixels) * 0.17, weight: .regular), .foregroundColor: NSColor(calibratedWhite: 0.8, alpha: 1)]
        let bounds = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: (CGFloat(pixels) - bounds.width) / 2, y: (CGFloat(pixels) - bounds.height) / 2), withAttributes: attributes)
        NSGraphicsContext.restoreGraphicsState()
        let data = bitmap.representation(using: .png, properties: [:])!
        let suffix = scale == 2 ? "@2x" : ""
        try data.write(to: root.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
