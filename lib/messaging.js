// Broadcasts from the offscreen document (DIAG, MODEL_*, AUDIO_*) are consumed
// by the side panel, which is often closed. chrome.runtime.sendMessage then
// rejects with "Receiving end does not exist" — an unhandled rejection for a
// message nobody needed. Swallow it: these are status updates, not commands.
export function send(message) {
  try {
    chrome.runtime.sendMessage(message)?.catch?.(() => {});
  } catch {
    /* context torn down mid-send */
  }
}
