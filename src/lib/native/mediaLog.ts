import { NativeMedia } from "./nativeMedia";

// Logs every native media state change (iOS app only). Capacitor forwards
// console output to Xcode and `devicectl --console`, so each "[media]" line
// records when the mic and camera turned on or off, and why.
void NativeMedia.addListener("mediaState", ({ mode, mic, camera, leases, reason }) => {
  console.log(`[media] mode=${mode} mic=${mic} camera=${camera} leases=${leases} reason=${reason}`);
});

void NativeMedia.getState().then(
  ({ mode, mic, camera, leases }) =>
    console.log(`[media] web view attached: mode=${mode} mic=${mic} camera=${camera} leases=${leases}`),
  (err) => console.error("[media] NativeMedia plugin unavailable:", err),
);
