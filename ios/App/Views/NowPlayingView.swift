import AVKit
import SoundsibleKit
import SwiftUI

/// The system output picker — AirPlay 2 speakers, the car, headphones.
///
/// It is `AVRoutePickerView` and nothing else: routing is the system's to
/// decide, and an app that builds its own list gets one that is wrong the moment
/// a speaker appears.
struct RoutePickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.prioritizesVideoDevices = false
        picker.tintColor = .secondaryLabel
        picker.activeTintColor = .tintColor
        return picker
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

struct NowPlayingView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss

    @State private var scrubbing: Double?

    var body: some View {
        VStack(spacing: 24) {
            Capsule()
                .fill(.secondary.opacity(0.4))
                .frame(width: 40, height: 5)
                .padding(.top, 8)

            Spacer(minLength: 0)

            VStack(spacing: 6) {
                Text(player.current?.title ?? "Nothing playing")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(player.current?.artist ?? "")
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 32)

            scrubber

            HStack(spacing: 44) {
                Button { player.previous() } label: {
                    Image(systemName: "backward.fill").font(.title)
                }
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 64))
                }
                Button { player.next() } label: {
                    Image(systemName: "forward.fill").font(.title)
                }
            }
            .buttonStyle(.plain)

            HStack(spacing: 32) {
                Button {
                    player.setShuffled(!player.isShuffled)
                } label: {
                    Image(systemName: "shuffle")
                        .foregroundStyle(player.isShuffled ? Color.accentColor : .secondary)
                }
                Button {
                    player.repeatMode = player.repeatMode.next
                } label: {
                    Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                        .foregroundStyle(player.repeatMode == .off ? .secondary : Color.accentColor)
                }
                RoutePickerButton()
                    .frame(width: 28, height: 28)
                    .accessibilityLabel("Choose where to play")
            }
            .buttonStyle(.plain)
            .font(.title3)

            Spacer(minLength: 0)
        }
        .padding(.bottom, 32)
        .presentationDragIndicator(.hidden)
    }

    private var scrubber: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(
                    get: { scrubbing ?? player.positionSec },
                    set: { scrubbing = $0 }
                ),
                in: 0...max(1, player.durationSec ?? 1),
                onEditingChanged: { editing in
                    if !editing, let target = scrubbing {
                        player.seek(to: target)
                        scrubbing = nil
                    }
                }
            )
            .disabled(player.durationSec == nil)

            HStack {
                Text(clock(scrubbing ?? player.positionSec))
                Spacer()
                Text(player.durationSec.map(clock) ?? "--:--")
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 32)
    }

    private func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "--:--" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

extension RepeatMode {
    var next: RepeatMode {
        switch self {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }
}
