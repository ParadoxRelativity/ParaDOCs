// Plays one of the app's sounds for the desktop notifier: the same files the
// web client ships, from the copy bundled with the app. The main process calls
// play() with the file of a sound it has already checked, a level from 0 to 1,
// and the speaker chosen for calls (empty for the system default).
window.play = async (file, volume, speakerId) => {
  const audio = new Audio(`../resources/web/sounds/ogg/${file}.ogg`);
  audio.volume = Math.min(1, Math.max(0, volume));
  if (speakerId && audio.setSinkId) {
    // An unplugged device is refused; the system default plays it instead.
    await audio.setSinkId(speakerId).catch(() => {});
  }
  await audio.play();
};
