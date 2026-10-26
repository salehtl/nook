"""App Store Connect helper for nook-scan releases (signs API requests with the .p8 key; never prints it).

  uv run --no-project --python 3.12 --with pyjwt --with cryptography --with httpx python -I ios/scripts/asc.py status
  uv run ... ios/scripts/asc.py ensure-profile     # App Store profile for the local Apple Distribution cert, installed
  uv run ... ios/scripts/asc.py builds             # latest uploads and their processing state

Env: NOOK_ASC_ISSUER_ID, NOOK_ASC_KEY_PATH (AuthKey_<KEYID>.p8; key id taken from the name unless NOOK_ASC_KEY_ID).
"""
import base64
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import jwt

BUNDLE_ID = "com.salehtl.nookscan"
TEAM = "8CFG28JHP3"
PROFILE_NAME = "nook-scan App Store"
API = "https://api.appstoreconnect.apple.com/v1"
PROFILES_DIR = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"


def client() -> httpx.Client:
    key_path = Path(os.environ["NOOK_ASC_KEY_PATH"]).expanduser()
    key_id = os.environ.get("NOOK_ASC_KEY_ID") or key_path.stem.removeprefix("AuthKey_")
    now = int(time.time())
    token = jwt.encode({"iss": os.environ["NOOK_ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
                       key_path.read_text(), algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})
    return httpx.Client(base_url=API, headers={"Authorization": f"Bearer {token}"}, timeout=30)


def check(r: httpx.Response) -> dict:
    if r.status_code >= 400:
        errs = r.json().get("errors", [{}])
        sys.exit(f"asc: {r.request.method} {r.request.url.path} -> {r.status_code}: {errs[0].get('detail') or errs[0].get('title')}")
    return r.json() if r.content else {}


def local_distribution_serials() -> set[str]:
    """Serial numbers (uppercase hex) of Apple Distribution certificates for TEAM in the login keychain."""
    pem = subprocess.run(["security", "find-certificate", "-a", "-c", f"Apple Distribution", "-p"], capture_output=True, text=True).stdout
    serials = set()
    for block in pem.split("-----END CERTIFICATE-----"):
        if "BEGIN CERTIFICATE" not in block:
            continue
        out = subprocess.run(["openssl", "x509", "-noout", "-serial", "-subject"], input=block + "-----END CERTIFICATE-----\n",
                             capture_output=True, text=True).stdout
        if TEAM in out:
            serials.add(out.split("serial=")[1].split()[0].upper().lstrip("0"))
    return serials


def status(c: httpx.Client) -> dict:
    bundle = check(c.get("/bundleIds", params={"filter[identifier]": BUNDLE_ID}))["data"]
    bundle = [b for b in bundle if b["attributes"]["identifier"] == BUNDLE_ID]
    apps = check(c.get("/apps", params={"filter[bundleId]": BUNDLE_ID}))["data"]
    certs = check(c.get("/certificates", params={"filter[certificateType]": "DISTRIBUTION,IOS_DISTRIBUTION", "limit": 50}))["data"]
    local = local_distribution_serials()
    usable = [x for x in certs if x["attributes"]["serialNumber"].upper().lstrip("0") in local]
    profiles = check(c.get("/profiles", params={"filter[name]": PROFILE_NAME}))["data"]
    return {"bundle": bundle[0] if bundle else None, "app": apps[0] if apps else None, "certs": usable, "profiles": profiles}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    with client() as c:
        if cmd == "builds":   # latest uploads and their processing state
            app = check(c.get("/apps", params={"filter[bundleId]": BUNDLE_ID}))["data"][0]
            for b in check(c.get("/builds", params={"filter[app]": app["id"], "sort": "-uploadedDate", "limit": 5}))["data"]:
                a = b["attributes"]
                print(f"build {a['version']}: {a['processingState']}, uploaded {a['uploadedDate']}, expires {a.get('expirationDate')}")
            return
        s = status(c)
        print(f"bundle id {BUNDLE_ID}: {'registered' if s['bundle'] else 'NOT registered'}")
        print(f"app record: {s['app']['attributes']['name'] + ' (' + s['app']['id'] + ')' if s['app'] else 'MISSING: create it in App Store Connect → Apps → + New App'}")
        print(f"distribution certs usable from this Mac: {len(s['certs'])}")
        print(f"profile '{PROFILE_NAME}': {s['profiles'][0]['attributes']['profileState'] if s['profiles'] else 'none'}")
        if cmd != "ensure-profile":
            return
        if not s["bundle"]:
            sys.exit("asc: bundle id not registered (run an archive with -allowProvisioningUpdates first)")
        if not s["certs"]:
            sys.exit("asc: no Apple Distribution certificate in App Store Connect matches one in this Mac's keychain")
        prof = next((p for p in s["profiles"] if p["attributes"]["profileState"] == "ACTIVE"), None)
        if not prof:
            body = {"data": {"type": "profiles", "attributes": {"name": PROFILE_NAME, "profileType": "IOS_APP_STORE"},
                             "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": s["bundle"]["id"]}},
                                               "certificates": {"data": [{"type": "certificates", "id": s["certs"][0]["id"]}]}}}}
            prof = check(c.post("/profiles", json=body))["data"]
            print(f"created profile '{PROFILE_NAME}'")
        content = prof["attributes"].get("profileContent") or check(c.get(f"/profiles/{prof['id']}"))["data"]["attributes"]["profileContent"]
        PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        dest = PROFILES_DIR / f"{prof['attributes']['uuid']}.mobileprovision"
        dest.write_bytes(base64.b64decode(content))
        print(f"installed {dest.name} (uuid {prof['attributes']['uuid']})")


if __name__ == "__main__":
    main()
