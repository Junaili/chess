import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

func usage() -> Never {
    fputs("Usage: swift scripts/gif_to_mp4.swift input.gif output.mp4\n", stderr)
    exit(2)
}

guard CommandLine.arguments.count == 3 else {
    usage()
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil) else {
    fputs("Could not read GIF: \(inputURL.path)\n", stderr)
    exit(1)
}

let frameCount = CGImageSourceGetCount(source)
guard frameCount > 0,
      let firstImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    fputs("GIF has no readable frames: \(inputURL.path)\n", stderr)
    exit(1)
}

let width = firstImage.width
let height = firstImage.height
let colorSpace = CGColorSpaceCreateDeviceRGB()

func gifDelay(at index: Int) -> Double {
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
          let gifProps = props[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    else {
        return 0.2
    }

    let unclamped = gifProps[kCGImagePropertyGIFUnclampedDelayTime] as? Double
    let clamped = gifProps[kCGImagePropertyGIFDelayTime] as? Double
    let delay = unclamped ?? clamped ?? 0.2
    return max(delay, 0.02)
}

func makePixelBuffer(from image: CGImage) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let attrs: [CFString: Any] = [
        kCVPixelBufferCGImageCompatibilityKey: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    ]

    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        attrs as CFDictionary,
        &buffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer = buffer else {
        return nil
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
        return nil
    }

    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    guard let context = CGContext(
        data: baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }

    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return pixelBuffer
}

try? FileManager.default.removeItem(at: outputURL)

let writer: AVAssetWriter
do {
    writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
} catch {
    fputs("Could not create MP4 writer: \(error)\n", stderr)
    exit(1)
}

let videoSettings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
]

let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
input.expectsMediaDataInRealTime = false

let pixelBufferAttributes: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
]

let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: pixelBufferAttributes
)

guard writer.canAdd(input) else {
    fputs("Could not add video input to MP4 writer.\n", stderr)
    exit(1)
}
writer.add(input)

guard writer.startWriting() else {
    fputs("Could not start MP4 writer: \(writer.error?.localizedDescription ?? "unknown error")\n", stderr)
    exit(1)
}
writer.startSession(atSourceTime: .zero)

var presentationTime = CMTime.zero
let timescale: CMTimeScale = 600

for index in 0..<frameCount {
    while !input.isReadyForMoreMediaData {
        Thread.sleep(forTimeInterval: 0.01)
    }

    guard let image = CGImageSourceCreateImageAtIndex(source, index, nil),
          let pixelBuffer = makePixelBuffer(from: image)
    else {
        fputs("Could not render GIF frame \(index).\n", stderr)
        exit(1)
    }

    if !adaptor.append(pixelBuffer, withPresentationTime: presentationTime) {
        fputs("Could not append frame \(index): \(writer.error?.localizedDescription ?? "unknown error")\n", stderr)
        exit(1)
    }

    let frameDuration = CMTime(seconds: gifDelay(at: index), preferredTimescale: timescale)
    presentationTime = presentationTime + frameDuration
}

input.markAsFinished()

let group = DispatchGroup()
group.enter()
writer.finishWriting {
    group.leave()
}
group.wait()

guard writer.status == .completed else {
    fputs("Could not finish MP4: \(writer.error?.localizedDescription ?? "unknown error")\n", stderr)
    exit(1)
}

print("wrote \(outputURL.path)")
