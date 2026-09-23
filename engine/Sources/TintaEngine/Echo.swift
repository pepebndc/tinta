import CoreAudio
import Foundation

/// The output route decides the echo handling. Speakers need echo removal. Headphones do
/// not, and echo removal there only makes other audio quieter.
enum OutputRoute: String {
    case speakers
    case headphones

    static func current() -> OutputRoute {
        let device = CoreAudioQuery.property(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice,
            AudioObjectID(kAudioObjectUnknown))
        guard device != kAudioObjectUnknown else { return .speakers }
        let transport = CoreAudioQuery.property(device, kAudioDevicePropertyTransportType, UInt32(0))
        switch transport {
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE, kAudioDeviceTransportTypeUSB:
            return .headphones
        case kAudioDeviceTransportTypeBuiltIn:
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDataSource, mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain)
            var source: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &source)
            // 'hdpn' is the headphone jack of the built-in audio device.
            return status == noErr && source == 0x6864_706E ? .headphones : .speakers
        default:
            return .speakers
        }
    }
}

/// Removes microphone words that are residual speaker echo.
/// Measured on MacBook Pro speakers with voice processing on: echo words reach at most
/// 13% of the remote level at the same time. Speech into the microphone is louder.
enum EchoFilter {
    static let remoteActive: Float = 0.01
    static let maxRatio: Float = 0.2

    static func rms(_ samples: [Float], _ start: Double, _ end: Double) -> Float {
        let rate = Double(ChunkFormat.sampleRate)
        let a = max(0, Int(start * rate))
        let b = min(samples.count, Int(end * rate))
        guard b > a else { return 0 }
        var sum: Float = 0
        for i in a..<b { sum += samples[i] * samples[i] }
        return (sum / Float(b - a)).squareRoot()
    }

    static func isEcho(mic: [Float], remote: [Float], start: Double, end: Double) -> Bool {
        let remoteLevel = rms(remote, start, end)
        guard remoteLevel > remoteActive else { return false }
        return rms(mic, start, end) < remoteLevel * maxRatio
    }

    static func isEcho(micLevel: Float, remoteLevel: Float) -> Bool {
        remoteLevel > remoteActive && micLevel < remoteLevel * maxRatio
    }
}
