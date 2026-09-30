"""Print a Nova OS sign-in assertion for the builder (contract §1). Local testing only.

    python3 scripts/nova/assertion.py vincentbjohn@gmail.com "Vincent John" <nova_user_id>
The secret comes from NOVA_SITES_SSO_SECRET in the environment; it is never printed.
"""
import base64, hashlib, hmac, json, os, sys, time

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

email, name, user_id = sys.argv[1], sys.argv[2], sys.argv[3]
payload = b64(json.dumps({"email": email, "name": name, "novaUserId": user_id, "exp": int(time.time()) + 120}).encode())
secret = os.environ["NOVA_SITES_SSO_SECRET"].encode()
print(payload + "." + b64(hmac.new(secret, payload.encode(), hashlib.sha256).digest()))
