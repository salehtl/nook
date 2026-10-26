#!/usr/bin/env bash
# Archive nook-scan and upload it to TestFlight with the App Store Connect API key in ~/.appstoreconnect/private_keys.
# Usage: NOOK_ASC_ISSUER_ID=<issuer uuid> [NOOK_ASC_KEY_PATH=path/to/AuthKey_ID.p8] bash ios/scripts/release.sh [build-number]
#   build-number defaults to the git commit count, so every upload gets a new one (TestFlight requires that).
# Needs: an App Store Connect app record for com.salehtl.nookscan (create it once in the web UI).
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${NOOK_ASC_ISSUER_ID:?set NOOK_ASC_ISSUER_ID (App Store Connect → Users and Access → Integrations → Issuer ID)}"
if [ -n "${NOOK_ASC_KEY_PATH:-}" ]; then
  # An explicit key file, e.g. NOOK_ASC_KEY_PATH=~/Downloads/AuthKey_XXXXXXXXXX.p8 (the key ID comes from the name).
  KEY_PATH="$NOOK_ASC_KEY_PATH"
  [ -f "$KEY_PATH" ] || { echo "release: $KEY_PATH not found" >&2; exit 1; }
  KEY_ID="${NOOK_ASC_KEY_ID:-$(basename "$KEY_PATH" .p8 | sed 's/^AuthKey_//')}"
else
  KEYS=(~/.appstoreconnect/private_keys/AuthKey_*.p8)
  [ -f "${KEYS[0]}" ] || { echo "release: no AuthKey_*.p8 in ~/.appstoreconnect/private_keys (or set NOOK_ASC_KEY_PATH)" >&2; exit 1; }
  [ "${#KEYS[@]}" -eq 1 ] || [ -n "${NOOK_ASC_KEY_ID:-}" ] || { echo "release: several API keys found, set NOOK_ASC_KEY_ID" >&2; exit 1; }
  KEY_ID="${NOOK_ASC_KEY_ID:-$(basename "${KEYS[0]}" .p8 | sed 's/^AuthKey_//')}"
  KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
fi
BUILD="${1:-$(git rev-list --count HEAD)}"
VERSION=$(awk '/MARKETING_VERSION:/ {print $2; exit}' ios/project.yml)
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$NOOK_ASC_ISSUER_ID")
OUT=build/release
rm -rf "$OUT" && mkdir -p "$OUT"

xcodegen generate --spec ios/project.yml --project ios >/dev/null
echo "archiving nook-scan $VERSION ($BUILD)…"
xcodebuild archive -project ios/NookScan.xcodeproj -scheme NookScan -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/NookScan.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD" "${AUTH[@]}" >"$OUT/archive.log" 2>&1 \
  || { grep -E "error:" "$OUT/archive.log" | head -n 5 >&2; echo "release: archive failed (log: $OUT/archive.log)" >&2; exit 1; }

# The App Store profile for the local Apple Distribution certificate (API keys without cloud-signing access can't
# use Apple's cloud-managed certificate, so the export signs manually with this one).
NOOK_ASC_KEY_PATH="$KEY_PATH" NOOK_ASC_KEY_ID="$KEY_ID" uv run -q --no-project --python 3.12 --with pyjwt --with cryptography \
  --with httpx python -I ios/scripts/asc.py ensure-profile | sed 's/^/  /'

cat >"$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>8CFG28JHP3</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>com.salehtl.nookscan</key><string>nook-scan App Store</string></dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict></plist>
EOF
echo "uploading to App Store Connect…"
xcodebuild -exportArchive -archivePath "$OUT/NookScan.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" "${AUTH[@]}" >"$OUT/upload.log" 2>&1 \
  || { grep -E "error:|Error" "$OUT/upload.log" | head -n 8 >&2; echo "release: upload failed (log: $OUT/upload.log)" >&2; exit 1; }
grep -E "Upload succeeded|EXPORT SUCCEEDED|Uploaded" "$OUT/upload.log" | tail -n 2
echo "done: nook-scan $VERSION ($BUILD) uploaded. It appears in TestFlight after Apple finishes processing (usually 5–30 min)."
