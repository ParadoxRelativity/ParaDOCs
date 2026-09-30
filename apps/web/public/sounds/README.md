# App sounds

The sounds ParaDOCs plays for messages, notifications and calls. They come from
the ParaDOCs Sound Suite v1.0 (nylon guitar and marimba, D major pentatonic, all
synthesised from scratch).

## Where the files go

```
apps/web/public/sounds/
  ogg/<name>.ogg   played first
  m4a/<name>.m4a   fallback for browsers that cannot decode Ogg Opus
```

A file's name is the sound's name. A sound with variants has one file per
variant (`message_sent_v1` … `message_sent_v3`). The app picks one at random
each time and never plays the same one twice in a row. To change a sound,
replace **both** of its files, keeping the name. Nothing else needs changing.
To add a new sound, add it to `SOUNDS` in `src/lib/sounds.ts` along with its
playback level.

Vite copies this folder into the build unchanged. So the server, the desktop
app (which loads the server's pages) and the mobile app (which bundles the build)
all serve the files at `/sounds/...`.

## Format

**Ogg Opus, with AAC (`.m4a`) as the fallback.**

- Ogg Opus is the smallest format, keeps the masters' loudness almost exactly
  (±0.01 LU), and loops without a gap. The ringtones need gapless looping.
- Web Audio in older Safari, and the iOS app's web view, cannot decode Ogg
  Opus. The first time decoding fails, the player switches to M4A for every
  later sound. M4A adds up to 21 ms of encoder padding, which is harmless for
  the one-shot sounds.
- MP3 and the 24-bit WAV masters are not shipped. They are larger, and they add
  nothing that these two formats do not already cover.

## Playback

`src/lib/sounds.ts` decodes each file once and keeps it in memory. It plays each
sound at the level the suite recommends, multiplied by the volume in
**Settings → Appearance → Sounds**, where sounds can also be turned off. Sounds
go to the speaker chosen for calls wherever the browser allows it. **Busy**
status silences the sounds that interrupt: messages, mentions, ringing and
notifications. The feedback from your own call controls still plays.

In the desktop app, notifications from the operating system are **silent**,
and these sounds replace the system's. A connection's page, while it is loaded,
plays the sound for what it hears itself: direct messages in any workspace,
channel messages and mentions in the workspace it has open, and anything new
in its bell. The desktop
app plays `mention_or_dm`, `message_received` or `notification_generic` itself
for everything else: a server not opened yet this session, a channel in another
workspace, or no window open at all on macOS. Each conversation keeps only its
latest notification, and a mention gets its own, so a busy channel cannot push
it out. It uses a hidden window and the copy of these files
bundled with the app (`apps/desktop/src/main/soundPlayer.ts`). The system's sound
is used only if that player cannot load. See `apps/desktop/src/main/notifier.ts`.

## What plays when

| Sound | When |
|---|---|
| `message_sent` (3 variants) | Someone else's message arrives in the channel or DM you are looking at. There is no notification. Sending your own makes no sound |
| `message_received` (3 variants) | A message in a text channel you are not looking at, along with a notification |
| `mention_or_dm` | A direct message, or a mention of you, that you are not looking at, along with a notification |
| `message_failed` | Your message could not be sent |
| `reaction_added` | Someone reacts to one of your messages, in a conversation loaded this session |
| `notification_generic` | Something new reaches the bell: a work item, a document tag, an invitation |
| `error` | An error toast. It gives way to a more specific sound played at the same moment |
| `call_incoming` (loop) | Someone is calling you |
| `call_waiting` | Someone is calling you while you are already in a call (replaces the ringtone) |
| `call_outgoing` (loop) | You are calling someone and it is ringing |
| `call_connected` | Your call was answered (heard instead of `participant_joined`) |
| `call_declined` | Your call was declined (everyone declined, in a group) |
| `call_missed` | A call to you ended unanswered, or a call you made got no answer |
| `self_join_call` / `self_leave_call` | You join or leave a call. Moving a call between windows is silent |
| `participant_joined` / `participant_left` | Someone joins or leaves your call |
| `mic_unmute` / `mic_mute` (3 variants each) | You turn your microphone on or off |
| `camera_on` / `camera_off` | You turn your camera on or off |
| `screenshare_start` / `screenshare_stop` | You start or stop sharing your screen |
| `screenshare_remote_started` / `_stopped` | Someone else in the call starts or stops sharing |
| `connection_lost` / `connection_restored` | The call is reconnecting, or has reconnected (or has dropped) |

## Sounds in the suite that are not used yet

These need features ParaDOCs does not have yet, so their files are not copied
here. They are still in the suite. PARA-35 tracks the work.

| Sound | Missing feature |
|---|---|
| `deafen` / `undeafen` | Deafening yourself in a call |
| `push_to_talk_on` / `push_to_talk_off` | Push-to-talk |
| `hand_raise` / `hand_lower` | Raising a hand in a call |
| `recording_started` / `recording_stopped` | Call recording |
| `screenshare_viewer_joined` / `_left` | Tracking who is watching a screen share |
| `screenshare_request` | Asking someone to share their screen |
| `muted_talking_hint` | Noticing that you are talking while muted |
| `connection_poor` | A call-quality indicator (connection quality is not shown anywhere yet) |
| `warning` | A warning level. Toasts are only "success" or "error" |
| `call_ended` | A separate "call ended" moment. Hanging up already plays `self_leave_call`, and the other side leaving plays `participant_left` |
| `message_received_background` | Not skipped for lack of a feature. A conversation you have open but are not looking at is treated like any other one you are not looking at, and gets `message_received` or `mention_or_dm` |
| `success` | Not skipped for lack of a feature. Success toasts are routine confirmations, such as a copied link, and a sound on each would be intrusive. It can be added in `Toast.tsx` beside `error` |
