#!/usr/bin/env bash
# nook-scan iOS eval (contract §4.7 I1, I3): generate, build (simulator + generic device), test, validate the replay
# capture, check release settings. No signing, no network to Apple. Output lands in evals/out/ios/.
# Usage: bash evals/ios_build.sh   (or npm run eval:ios)
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evals/out/ios
DD="$OUT/dd"
SIM="${NOOK_SIM:-iPhone 18 Pro}"
mkdir -p "$OUT"
pass=0; fail=0
ok()  { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1${3:+ — $3}"; fi; }
# Like check, but the failure detail is a command run after the check, so it can read logs the check just wrote.
checkl() { if eval "$2"; then ok "$1"; else bad "$1 — $(eval "$3" 2>/dev/null | tr '\n' ' ' | cut -c1-600)"; fi; }

[ -f ios/project.yml ] || { echo "FAIL ios/project.yml not found (app not built yet)"; exit 1; }
checkl "xcodegen generates the project" 'xcodegen generate --spec ios/project.yml --project ios >"$OUT/xcodegen.log" 2>&1' 'tail -n 3 "$OUT/xcodegen.log"'
PROJ=$(ls -d ios/*.xcodeproj 2>/dev/null | head -n 1)
[ -n "$PROJ" ] || { echo "FAIL no .xcodeproj generated"; exit 1; }

# Unit tests on the simulator (includes ReplayCaptureTests.testReplayWritesValidCapture).
UDID=$(xcrun simctl list devices available -j | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')).devices; const all=Object.values(d).flat(); const m=all.find(x=>x.name===process.argv[1]); console.log(m?m.udid:'')" "$SIM")
[ -n "$UDID" ] || { echo "FAIL no available simulator named '$SIM' (set NOOK_SIM)"; exit 1; }
marker="$OUT/.test-start"; : >"$marker"
# Processing server for ServerClientTests (contract §5): the mock by default, or a real one via NOOK_SERVER_URL.
# The simulator shares the Mac's network, so 127.0.0.1 here is reachable from the tests.
if [ -z "${NOOK_SERVER_URL:-}" ]; then
  python3 evals/mock_scan_server.py --port 8798 --seconds 4 >"$OUT/mock.log" 2>&1 &
  MOCK_PID=$!; trap 'kill $MOCK_PID 2>/dev/null' EXIT
  NOOK_SERVER_URL=http://127.0.0.1:8798
  for _ in $(seq 1 30); do curl -sf "$NOOK_SERVER_URL/api/scan/health" >/dev/null && break; sleep 0.2; done
fi
if TEST_RUNNER_NOOK_SERVER_URL="$NOOK_SERVER_URL" xcodebuild test -project "$PROJ" -scheme NookScan -destination "id=$UDID" -derivedDataPath "$DD" >"$OUT/test.log" 2>&1; then
  ok "unit tests pass on $SIM ($(grep -Eo 'Executed [0-9]+ tests?' "$OUT/test.log" | tail -n 1))"
else
  bad "unit tests pass on $SIM — $(grep -E 'error:|failed|FAILED' "$OUT/test.log" | head -n 5 | tr '\n' ' ' | cut -c1-600)"
fi
check "ReplayCaptureTests.testReplayWritesValidCapture ran" 'grep -q "testReplayWritesValidCapture.*passed" "$OUT/test.log"'
# v0.2 (contract §4.8, §5): these must exist and pass.
check "ExposureLockTests ran and passed" 'grep -E "ExposureLock" "$OUT/test.log" | grep -q passed && ! grep -E "ExposureLock" "$OUT/test.log" | grep -q failed'
check "JobDecodingTests ran and passed" 'grep -E "JobDecoding" "$OUT/test.log" | grep -q passed && ! grep -E "JobDecoding" "$OUT/test.log" | grep -q failed'
check "ServerClientTests.testUploadAndPollAgainstServer passed against $NOOK_SERVER_URL" 'grep -q "testUploadAndPollAgainstServer.*passed" "$OUT/test.log"'

# The capture the replay test wrote, found in the simulator's data container.
CAP=$(find "$HOME/Library/Developer/CoreSimulator/Devices/$UDID/data" -path '*nook-eval-capture/transforms.json' -newer "$marker" 2>/dev/null | head -n 1)
if [ -n "$CAP" ]; then
  CAPDIR=$(dirname "$CAP"); rm -rf "$OUT/replay-capture"; cp -R "$CAPDIR" "$OUT/replay-capture"
  checkl "replay capture passes validate_capture.py (≥ 20 frames)" 'evals/py evals/validate_capture.py "$OUT/replay-capture" --min-frames 20 >"$OUT/validate.out" 2>&1' 'head -n 5 "$OUT/validate.out"'
else
  bad "replay test wrote <tmp>/nook-eval-capture/transforms.json in the simulator"
fi

# Device build (unsigned): catches ARKit/LiDAR APIs that only exist for real devices.
checkl "builds for generic iOS device (unsigned)" 'xcodebuild build -project "$PROJ" -scheme NookScan -destination "generic/platform=iOS" -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO >"$OUT/device.log" 2>&1' 'grep -E "error:" "$OUT/device.log" | head -n 3'

# Release settings (I3), read from the built device app and the build settings.
APP=$(ls -d "$DD"/Build/Products/Release-iphoneos/*.app "$DD"/Build/Products/Debug-iphoneos/*.app 2>/dev/null | head -n 1)
if [ -n "$APP" ]; then
  P="$APP/Info.plist"
  pl() { plutil -extract "$1" raw -o - "$P" 2>/dev/null; }
  check "bundle id com.salehtl.nookscan" '[ "$(pl CFBundleIdentifier)" = "com.salehtl.nookscan" ]' "$(pl CFBundleIdentifier)"
  check "version 0.3.0" '[ "$(pl CFBundleShortVersionString)" = "0.3.0" ]' "$(pl CFBundleShortVersionString) ($(pl CFBundleVersion))"
  check "NSCameraUsageDescription is set" '[ -n "$(pl NSCameraUsageDescription)" ]'
  check "ITSAppUsesNonExemptEncryption is false" '[ "$(pl ITSAppUsesNonExemptEncryption)" = "false" ]'
  check "UIRequiredDeviceCapabilities includes arkit" 'plutil -extract UIRequiredDeviceCapabilities json -o - "$P" 2>/dev/null | grep -q arkit'
  check "deployment target iOS 18.0" '[ "$(pl MinimumOSVersion)" = "18.0" ]' "$(pl MinimumOSVersion)"
  check "app icon compiled (Assets.car + CFBundleIcons)" '[ -f "$APP/Assets.car" ] && plutil -extract CFBundleIcons json -o - "$P" >/dev/null 2>&1'
else
  bad "built device .app found for Info.plist checks"
fi
SETTINGS=$(xcodebuild -showBuildSettings -project "$PROJ" -scheme NookScan -configuration Release 2>/dev/null)
check "DEVELOPMENT_TEAM 8CFG28JHP3 with automatic signing" 'echo "$SETTINGS" | grep -qE "^\s*DEVELOPMENT_TEAM = 8CFG28JHP3$" && echo "$SETTINGS" | grep -qE "^\s*CODE_SIGN_STYLE = Automatic$"'

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
