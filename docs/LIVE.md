# Live — broadcasting your Soundsible

Live turns your Soundsible into a radio station. Anyone with a browser can
listen from the public hub — no account, no Soundsible, nothing to install:

**<https://arzuparreta.github.io/soundsible.github.io/live/>**

Your station never serves the audio. It publishes one Opus stream to the
Community relay, and the relay fans it out to listeners.

---

## 1. What goes on air

**Everything you hear.** The broadcast is tapped from the program bus, after
both decks, the EQ and filters, the crossfade and the echo send, and after the
limiter. Auto Mode transitions, Now Playing, ordinary playback, previews,
podcasts and radio all run through the same two audio elements, so all of it is
broadcast exactly as you hear it.

The only audio *not* broadcast is another DJ's room when you are listening to
one yourself.

## 2. Your volume is not the listeners' volume

Local volume and mute sit **downstream** of the broadcast tap. Turning
Soundsible down, muting it, muting the browser tab, or turning the computer's
volume to zero changes nothing for your listeners: the stream stays at full
level. This is deliberate — you can monitor on headphones, or work in silence,
while the room keeps hearing the set.

The one case where nothing goes out is a failed audio engine. If the mixing
graph dies, the tap dies with it and the room says so: *"The mixer stopped and
took the broadcast with it. Reload Soundsible to go back on air."* Reload the
page and go live again.

## 3. Pauses and breaks

Pausing does **not** drop the connection. The stream stays up and carries
digital silence, which is what keeps the connection alive through a break.

Listeners see the room switch to **"Back in a moment"** with a counter, so a
break reads as a break and not as a broken stream. Your own host card tells you
how long you have been silent on air once the gap passes half a minute. The
directory shows the room as **"On a break"** rather than pretending it is
playing.

There is no maximum break length. A room on a break is a live room.

## 4. How long a broadcast lasts

There is no time limit. A session lives as long as your browser tab is open and
connected.

- **Your browser is the encoder.** Closing the tab stops the broadcast.
- **Fifteen seconds of grace.** If the tab closes or the connection drops, the
  room is held for 15 seconds and resumes automatically if you come back. After
  that the room is deleted.
- **Thirty minutes of patience.** A room that never plays a single note
  releases its slot after 30 minutes, so it does not hold one of the few
  concurrent slots away from a DJ with music to play. A room on a break is
  never idle.
- **Phones are fragile hosts.** Backgrounding the tab can let the operating
  system suspend the audio engine, which takes the broadcast with it. Broadcast
  from a machine whose screen stays on.

Limits: 5 concurrent sessions, 100 listeners per room, 250 listeners in total.
Nothing is recorded — no replay, no archive, and chat is never stored.

## 5. Broadcasting needs HTTPS

Browsers hide the ICE candidates WebRTC needs on origins they do not trust, so
`http://192.168.x.x:5005` cannot broadcast. Any one of these works:

| Path | How |
|---|---|
| Same machine | Open `http://localhost:5005` — localhost is trusted |
| Remote, easiest | `tailscale serve --bg --yes 5005`, then open the `https://…ts.net` address it prints |
| Your own domain | Put Soundsible behind HTTPS and set `SOUNDSIBLE_HTTPS_URL=https://your.domain` |

When the origin is not trusted, the Live page says so and offers a link to the
secure address if it can find one. Following that link is a handoff, not just a
change of address: the insecure page publishes its session on the way out, the
secure one opens the room by itself on arrival, and the session you were
listening to — queue, mode, and the whole Auto Mode workspace when Auto was
driving — is offered back by the resume banner. A different origin is a
different device as far as the browser is concerned, which is why it arrives as
an offer rather than simply carrying on.

**Listening has no such requirement** — the public hub is already HTTPS.

## 6. Checking that your stream actually sounds

1. Go live and press play. The host card turns to **On air**.
2. Press **Share room** and send yourself the link.
3. Open it **on another device** — a phone on mobile data is the best test,
   because it proves the stream survives a network that is not your own.
4. Press **Listen live**.

Two things to know:

- **Do not check by joining your own room from the player.** Entering a room
  pauses your playback, which is the very thing you are broadcasting. Your own
  room is therefore not clickable in the directory; use the shared link on a
  second device instead.
- A second tab or a private window on the same machine works fine as a quick
  check, but it will not catch problems that only appear on other networks.

If the listener side fails on a restrictive network, it will reconnect on its
own for a short bounded window before giving up and offering a manual retry.

## 7. Turning it off

Live is on by default and uses the official relay. To point at your own relay
or switch the feature off entirely:

```bash
SOUNDSIBLE_COMMUNITY_URL=https://your-relay.example   # your own HTTPS relay
SOUNDSIBLE_COMMUNITY_DISABLED=true                    # off entirely
```

Running your own relay is documented in
[`deploy/community/README.md`](../deploy/community/README.md).

## 8. What the relay knows about you

Your station holds an Ed25519 key and signs every control request with it. Your
identity on the relay is derived from that key: there is no account, no
password and no email. The relay stores the room, your display name and avatar
colour, and hashes of the session tokens. Track ids are replaced with random
ones before publishing, and cover art is re-encoded and re-uploaded rather than
linked back to your library.
