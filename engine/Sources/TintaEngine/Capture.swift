import AppKit
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
        let status = withUnsafeMutableBytes(of: &value) {
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!)
        }
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
        /// The bundle ID of the app that is responsible for the process, when it is a different process.
        /// A web view plays its audio from a WebKit process, which has a WebKit bundle ID.
        let appBundleID: String
        let isRunningInput: Bool
        let isRunningOutput: Bool

        /// True when the bundle ID of the process or of its responsible app starts with the prefix.
        func belongs(to prefix: String) -> Bool {
            bundleID.hasPrefix(prefix) || appBundleID.hasPrefix(prefix)
        }
    }

    static func processes() -> [AudioProcess] {
        array(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).map { object in
            let pid = property(object, kAudioProcessPropertyPID, pid_t(-1))
            return AudioProcess(
                object: object,
                pid: pid,
                bundleID: string(object, kAudioProcessPropertyBundleID) ?? "",
                appBundleID: appBundleID(pid: pid),
                isRunningInput: property(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) != 0,
                isRunningOutput: property(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0)
        }
    }

    /// `responsibility_get_pid_responsible_for_pid` from libSystem. macOS has no public API for the responsible process.
    private static let responsiblePID: (@convention(c) (pid_t) -> pid_t)? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
        else { return nil }
        return unsafeBitCast(symbol, to: (@convention(c) (pid_t) -> pid_t).self)
    }()

    private static func appBundleID(pid: pid_t) -> String {
        guard pid > 0, let responsible = responsiblePID?(pid), responsible > 0, responsible != pid else { return "" }
        return NSRunningApplication(processIdentifier: responsible)?.bundleIdentifier ?? ""
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
/// A process matches the prefix by its own bundle ID or by the bundle ID of its responsible app.
/// The capture scans for matching processes every second, because an app creates
/// its audio process only when it plays audio. It also builds a new tap when the default
/// output device or the tap format changes, and when a matching process plays audio but
/// the tap delivers only silence for 2.5 seconds. A device change can leave a tap silent.
final class ProcessTapCapture: @unchecked Sendable {
    private let source: String
    private let handler: SampleHandler
    private let onState: (_ capturing: Bool, _ processes: Int) -> Void
    private let queue = DispatchQueue(label: "tinta.tap")
    /// The IO callback has its own queue. The audio IO thread waits for this queue, so a
    /// teardown on `queue` can stop the device while a callback is due.
    private let ioQueue = DispatchQueue(label: "tinta.tap.io", qos: .userInteractive)
    private let lock = NSLock()
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var tappedObjects: [AudioObjectID] = []
    private var tappedOutput: String?
    private var tappedFormat: AudioStreamBasicDescription?
    /// The last time the tap delivered sound, or the time of the build. `lock` protects it.
    private var lastSound = Date()
    private static let silenceLimit = 2.5
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
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.refresh() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        timer?.cancel()
        timer = nil
        queue.sync { self.teardown() }
    }

    /// The processes to tap. The engine and this helper do not count.
    private func matchingProcesses() -> [CoreAudioQuery.AudioProcess] {
        let own: Set<pid_t> = [getpid(), getppid()]
        return CoreAudioQuery.processes().filter { !own.contains($0.pid) && (source == "all" || $0.belongs(to: source)) }
            .sorted { $0.object < $1.object }
    }

    private func refresh() {
        let processes = matchingProcesses()
        let objects = source == "all" ? [] : processes.map(\.object)
        if source != "all" && objects.isEmpty {
            if isCapturing { teardown() }
            return
        }
        let output = CoreAudioQuery.defaultOutputUID()
        if isCapturing && objects == tappedObjects && output == tappedOutput {
            lock.lock()
            let silent = Date().timeIntervalSince(lastSound)
            lock.unlock()
            if tapFormat().map({ !Self.sameFormat($0, tappedFormat) }) ?? false {
                Output.shared.log("process tap restarts: the tap format changed")
            } else if silent >= Self.silenceLimit && processes.contains(where: \.isRunningOutput) {
                Output.shared.log("process tap restarts: no sound for \(Int(silent)) seconds while the app plays audio")
            } else {
                return
            }
        }
        teardown()
        do {
            try build(objects: objects)
            tappedObjects = objects
            tappedOutput = output
            isCapturing = true
            if source != "all" {
                let names = processes.map { $0.appBundleID.isEmpty ? $0.bundleID : "\($0.bundleID) (\($0.appBundleID))" }
                Output.shared.log("process tap: \(names.joined(separator: ", "))")
            }
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

        guard var streamDescription = tapFormat(), let format = AVAudioFormat(streamDescription: &streamDescription) else {
            throw EngineError("no tap format")
        }
        tappedFormat = streamDescription
        lock.lock()
        lastSound = Date()
        lock.unlock()

        let handler = self.handler
        let resampler = self.resampler
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { [weak self] _, input, inputTime, _, _ in
            guard
                let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil)
            else { return }
            let samples = resampler.convert(buffer)
            if let self, samples.contains(where: { $0 != 0 }) {
                self.lock.lock()
                self.lastSound = Date()
                self.lock.unlock()
            }
            if !samples.isEmpty {
                handler(samples, inputTime.pointee.mHostTime)
            }
        }
        guard status == noErr, let procID else { throw EngineError("IO proc status \(status)") }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { throw EngineError("AudioDeviceStart status \(status)") }
    }

    private func tapFormat() -> AudioStreamBasicDescription? {
        guard tapID != kAudioObjectUnknown else { return nil }
        var description = AudioStreamBasicDescription()
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        return AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description) == noErr ? description : nil
    }

    private static func sameFormat(_ a: AudioStreamBasicDescription, _ b: AudioStreamBasicDescription?) -> Bool {
        guard let b else { return false }
        return a.mSampleRate == b.mSampleRate && a.mChannelsPerFrame == b.mChannelsPerFrame
            && a.mFormatID == b.mFormatID && a.mFormatFlags == b.mFormatFlags
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
        tappedOutput = nil
        tappedFormat = nil
    }
}

// MARK: - Microphone

/// Captures the default input device. Voice processing removes echo when the sound plays
/// through speakers. With headphones, the capture records the microphone directly, because
/// voice processing there only makes other audio quieter. With voice processing, channel 0
/// carries the processed voice. The other channels carry raw microphone and reference
/// signals, so the capture uses channel 0 only.
///
/// AVAudioEngine stops when the audio hardware changes its configuration, for example when
/// Bluetooth headphones switch to their microphone mode as a call app unmutes. The capture
/// then starts a new engine. It also starts a new engine when no audio arrives for 2 seconds,
/// and when the sound moves between speakers and headphones.
final class MicCapture: @unchecked Sendable {
    private var engine = AVAudioEngine()
    private let handler: SampleHandler
    private let resampler = Resampler()
    /// The output route of the current engine. Only `queue` uses it.
    private var route = OutputRoute.speakers
    /// True after the warning that echo removal is not available. Only `queue` uses it.
    private var warnedNoEchoRemoval = false

    private let queue = DispatchQueue(label: "tinta.mic")
    private let lock = NSLock()
    private var lastBuffer = Date()
    private var lastRestart = Date.distantPast
    private var running = false
    private var watchdog: DispatchSourceTimer?
    private var observer: NSObjectProtocol?
    private static let silenceLimit = 2.0

    init(handler: @escaping SampleHandler) {
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
        route = OutputRoute.current()
        if route == .speakers {
            do {
                try startEngine(voiceProcessing: true)
                return
            } catch {
                Output.shared.log("voice processing failed, recording without echo removal: \(error)")
                resetEngine()
                if !warnedNoEchoRemoval {
                    warnedNoEchoRemoval = true
                    Output.shared.event(
                        "warning",
                        ["message": "Echo removal is not available with this audio device. Use headphones to avoid echo."])
                }
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

    /// Starts a new engine after a configuration change, a silent input, or a route change. Runs on `queue`.
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
        if silent >= Self.silenceLimit {
            restart("no audio for \(Int(silent)) seconds")
        } else if OutputRoute.current() != route {
            restart("the sound moved to \(OutputRoute.current().rawValue)")
        }
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
