import AVFoundation
import CoreAudio
import Foundation

/// Converts host time to seconds on the meeting clock.
enum Clock {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func seconds(hostTime: UInt64) -> Double {
        Double(hostTime) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
    }

    static func now() -> UInt64 { mach_absolute_time() }
}

/// Converts any PCM buffer to 16 kHz mono Float32.
final class Resampler {
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(ChunkFormat.sampleRate), channels: 1,
        interleaved: false)!
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
        if sourceFormat != buffer.format {
            sourceFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else { return [] }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let error {
            Output.shared.log("resample failed: \(error)")
            return []
        }
        guard let data = output.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(output.frameLength)))
    }
}

typealias SampleHandler = (_ samples: [Float], _ hostTime: UInt64) -> Void

// MARK: - Core Audio helpers

enum CoreAudioQuery {
    static func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ fallback: T) -> T {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<T>.size)
        var value = fallback
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        return status == noErr ? value : fallback
    }

    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: Unmanaged<CFString>?
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    static func array(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    struct AudioProcess {
        let object: AudioObjectID
        let pid: pid_t
        let bundleID: String
        let isRunningOutput: Bool
    }

    static func processes() -> [AudioProcess] {
        array(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).map { object in
            AudioProcess(
                object: object,
                pid: property(object, kAudioProcessPropertyPID, pid_t(-1)),
                bundleID: string(object, kAudioProcessPropertyBundleID) ?? "",
                isRunningOutput: property(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0)
        }
    }

    static func defaultOutputUID() -> String? {
        let device = property(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice,
            AudioObjectID(kAudioObjectUnknown))
        guard device != kAudioObjectUnknown else { return nil }
        return string(device, kAudioDevicePropertyDeviceUID)
    }

    static func defaultInputName() -> String? {
        let device = property(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice,
            AudioObjectID(kAudioObjectUnknown))
        guard device != kAudioObjectUnknown else { return nil }
        return string(device, kAudioObjectPropertyName)
    }
}

// MARK: - Remote audio through a process tap

/// Captures the output of the selected app with a Core Audio process tap.
/// The source is a bundle ID prefix, or "all" for all system audio except this engine.
/// The capture scans for matching processes every two seconds, because an app creates
/// its audio process only when it plays audio.
final class ProcessTapCapture: @unchecked Sendable {
    private let source: String
    private let handler: SampleHandler
    private let onState: (_ capturing: Bool, _ processes: Int) -> Void
    private let queue = DispatchQueue(label: "tinta.tap", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var tappedObjects: [AudioObjectID] = []
    private var timer: DispatchSourceTimer?
    private let resampler = Resampler()
    private(set) var isCapturing = false

    init(source: String, handler: @escaping SampleHandler, onState: @escaping (Bool, Int) -> Void) {
        self.source = source
        self.handler = handler
        self.onState = onState
    }

    func start() {
        queue.sync { self.refresh() }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.refresh() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        timer?.cancel()
        timer = nil
        queue.sync { self.teardown() }
    }

    private func matchingObjects() -> [AudioObjectID] {
        let own = getpid()
        let processes = CoreAudioQuery.processes().filter { $0.pid != own }
        if source == "all" { return [] }
        return processes.filter { $0.bundleID.hasPrefix(source) }.map(\.object).sorted()
    }

    private func refresh() {
        let objects = matchingObjects()
        if source != "all" && objects.isEmpty {
            if isCapturing { teardown() }
            return
        }
        if isCapturing && objects == tappedObjects { return }
        teardown()
        do {
            try build(objects: objects)
            tappedObjects = objects
            isCapturing = true
            onState(true, objects.count)
        } catch {
            Output.shared.log("process tap failed: \(error)")
        }
    }

    private func build(objects: [AudioObjectID]) throws {
        let description: CATapDescription
        if source == "all" {
            let ownObject = CoreAudioQuery.processes().filter { $0.pid == getpid() }.map(\.object)
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: ownObject)
        } else {
            description = CATapDescription(stereoMixdownOfProcesses: objects)
        }
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.name = "Tinta"

        var tap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr else { throw EngineError("AudioHardwareCreateProcessTap status \(status)") }
        tapID = tap

        guard let outputUID = CoreAudioQuery.defaultOutputUID() else { throw EngineError("no output device") }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Tinta Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]
            ],
        ]
        var device = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device)
        guard status == noErr else { throw EngineError("AudioHardwareCreateAggregateDevice status \(status)") }
        aggregateID = device

        var streamDescription = AudioStreamBasicDescription()
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &streamDescription)
        guard status == noErr, let format = AVAudioFormat(streamDescription: &streamDescription) else {
            throw EngineError("tap format status \(status)")
        }

        let handler = self.handler
        let resampler = self.resampler
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, inputTime, _, _ in
            guard
                let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil)
            else { return }
            let samples = resampler.convert(buffer)
            if !samples.isEmpty {
                handler(samples, inputTime.pointee.mHostTime)
            }
        }
        guard status == noErr, let procID else { throw EngineError("IO proc status \(status)") }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { throw EngineError("AudioDeviceStart status \(status)") }
    }

    private func teardown() {
        if let procID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        procID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        if isCapturing {
            isCapturing = false
            onState(false, 0)
        }
        tappedObjects = []
    }
}

// MARK: - Microphone

/// Captures the default input device. Voice processing removes echo from the speakers.
/// With voice processing, channel 0 carries the processed voice. The other channels carry
/// raw microphone and reference signals, so the capture uses channel 0 only.
///
/// AVAudioEngine stops when the audio hardware changes its configuration, for example when
/// Bluetooth headphones switch to their microphone mode as a call app unmutes. The capture
/// then starts a new engine. It also starts a new engine when no audio arrives for 2 seconds.
final class MicCapture: @unchecked Sendable {
    private var engine = AVAudioEngine()
    private let handler: SampleHandler
    private let echoCancellation: Bool
    private let resampler = Resampler()
    private(set) var echoCancellationActive = false

    private let queue = DispatchQueue(label: "tinta.mic")
    private let lock = NSLock()
    private var lastBuffer = Date()
    private var lastRestart = Date.distantPast
    private var running = false
    private var watchdog: DispatchSourceTimer?
    private var observer: NSObjectProtocol?
    private static let silenceLimit = 2.0

    init(echoCancellation: Bool, handler: @escaping SampleHandler) {
        self.echoCancellation = echoCancellation
        self.handler = handler
    }

    func start() throws {
        try queue.sync {
            try startCapture()
            running = true
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.checkFlow() }
        timer.resume()
        watchdog = timer
    }

    private func startCapture() throws {
        lock.lock()
        lastBuffer = Date()
        lock.unlock()
        if echoCancellation {
            do {
                try startEngine(voiceProcessing: true)
                echoCancellationActive = true
                return
            } catch {
                Output.shared.log("voice processing failed, recording without echo removal: \(error)")
                resetEngine()
                if !echoCancellationActive {
                    Output.shared.event(
                        "warning",
                        ["message": "Echo removal is not available with this audio device. Use headphones to avoid echo."])
                }
                echoCancellationActive = false
            }
        }
        try startEngine(voiceProcessing: false)
    }

    /// Stops the current engine and replaces it with a new one. Runs on `queue`.
    private func resetEngine() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine = AVAudioEngine()
    }

    /// Starts a new engine after a configuration change or a silent input. Runs on `queue`.
    private func restart(_ reason: String) {
        guard running, Date().timeIntervalSince(lastRestart) >= Self.silenceLimit else { return }
        lastRestart = Date()
        Output.shared.log("microphone capture restarts: \(reason)")
        resetEngine()
        do {
            try startCapture()
        } catch {
            Output.shared.log("microphone restart failed: \(error)")
        }
    }

    private func checkFlow() {
        lock.lock()
        let silent = Date().timeIntervalSince(lastBuffer)
        lock.unlock()
        if silent >= Self.silenceLimit { restart("no audio for \(Int(silent)) seconds") }
    }

    private func startEngine(voiceProcessing: Bool) throws {
        let input = engine.inputNode
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: false, duckingLevel: .min)
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw EngineError("microphone unavailable") }
        let handler = self.handler
        let resampler = self.resampler
        let firstChannel = voiceProcessing && format.channelCount > 1
        let mono = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)!
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, time in
            if let self {
                self.lock.lock()
                self.lastBuffer = Date()
                self.lock.unlock()
            }
            var source = buffer
            if firstChannel, let data = buffer.floatChannelData,
                let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
                let target = copy.floatChannelData
            {
                copy.frameLength = buffer.frameLength
                target[0].update(from: data[0], count: Int(buffer.frameLength))
                source = copy
            }
            let samples = resampler.convert(source)
            let host = time.isHostTimeValid ? time.hostTime : Clock.now()
            if !samples.isEmpty { handler(samples, host) }
        }
        engine.prepare()
        try engine.start()
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.queue.async { self?.restart("the audio configuration changed") }
        }
    }

    func stop() {
        watchdog?.cancel()
        watchdog = nil
        queue.sync {
            running = false
            resetEngine()
        }
    }
}
