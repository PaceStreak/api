"""Passkeys, exercised end to end with a software authenticator.

Nothing about the WebAuthn verification is mocked: the authenticator below
builds real CBOR attestation objects and real ECDSA signatures over real
client data, so these tests fail if origin, rp id, challenge or signature
checking is wrong.
"""

import hashlib
import json
import os
import struct

import pyotp
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, encode_cbor

from app.config import get_settings
from tests.conftest import PASSWORD, bearer, login, register

settings = get_settings()


class SoftAuthenticator:
    """A platform authenticator in forty lines: one P-256 key, user verified."""

    def __init__(self, origin: str | None = None, rp_id: str | None = None):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.origin = origin or settings.passkey_origin
        self.rp_id = rp_id or settings.passkey_rp_id
        self.count = 0
        self.user_handle: bytes | None = None

    def _cose_key(self) -> bytes:
        numbers = self.key.public_key().public_numbers()
        return encode_cbor(
            {
                1: 2,  # kty: EC2
                3: -7,  # alg: ES256
                -1: 1,  # crv: P-256
                -2: numbers.x.to_bytes(32, "big"),
                -3: numbers.y.to_bytes(32, "big"),
            }
        )

    def _client_data(self, kind: str, challenge: str) -> bytes:
        return json.dumps(
            {"type": kind, "challenge": challenge, "origin": self.origin, "crossOrigin": False}
        ).encode()

    def create(self, options: dict) -> dict:
        self.user_handle = base64url_to_bytes(options["user"]["id"])
        client_data = self._client_data("webauthn.create", options["challenge"])
        # Flags: user present (0x01) | user verified (0x04) | attested data (0x40).
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([0x45])
            + struct.pack(">I", self.count)
            + bytes(16)  # AAGUID
            + struct.pack(">H", len(self.credential_id))
            + self.credential_id
            + self._cose_key()
        )
        attestation = encode_cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})
        cid = bytes_to_base64url(self.credential_id)
        return {
            "id": cid,
            "rawId": cid,
            "type": "public-key",
            "response": {
                "clientDataJSON": bytes_to_base64url(client_data),
                "attestationObject": bytes_to_base64url(attestation),
                "transports": ["internal", "hybrid"],
            },
            "clientExtensionResults": {},
        }

    def get(self, options: dict, *, verified: bool = True) -> dict:
        self.count += 1
        client_data = self._client_data("webauthn.get", options["challenge"])
        flags = 0x05 if verified else 0x01
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([flags])
            + struct.pack(">I", self.count)
        )
        signature = self.key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        cid = bytes_to_base64url(self.credential_id)
        return {
            "id": cid,
            "rawId": cid,
            "type": "public-key",
            "response": {
                "clientDataJSON": bytes_to_base64url(client_data),
                "authenticatorData": bytes_to_base64url(auth_data),
                "signature": bytes_to_base64url(signature),
                "userHandle": bytes_to_base64url(self.user_handle or b""),
            },
            "clientExtensionResults": {},
        }


def enrol(client, token: str, device: SoftAuthenticator, name: str | None = None) -> dict:
    start = client.post(
        "/v1/auth/passkeys/register/options", json={"password": PASSWORD}, headers=bearer(token)
    )
    assert start.status_code == 200, start.text
    body = start.json()
    finish = client.post(
        "/v1/auth/passkeys/register",
        json={
            "challenge_id": body["challenge_id"],
            "credential": device.create(body["options"]),
            "name": name,
        },
        headers=bearer(token),
    )
    assert finish.status_code == 201, finish.text
    return finish.json()


def sign_in(client, device: SoftAuthenticator, **kwargs):
    options = client.post("/v1/auth/passkeys/sign-in/options").json()
    return client.post(
        "/v1/auth/passkeys/sign-in",
        json={
            "challenge_id": options["challenge_id"],
            "credential": device.get(options["options"], **kwargs),
        },
    )


def test_register_and_sign_in_with_a_passkey(client):
    email, _ = register(client, "pk@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    created = enrol(client, token, device, name="Work laptop")
    assert created["name"] == "Work laptop"

    listed = client.get("/v1/auth/passkeys", headers=bearer(token)).json()
    assert [p["id"] for p in listed] == [created["id"]]

    client.cookies.clear()
    response = sign_in(client, device)
    assert response.status_code == 200, response.text
    me = client.get("/v1/auth/me", headers=bearer(response.json()["access_token"]))
    assert me.json()["email"] == email

    events = client.get(
        "/v1/me/security-events", headers=bearer(response.json()["access_token"])
    ).json()
    kinds = [e["kind"] for e in events]
    assert "passkey_added" in kinds


def test_registration_requires_the_password(client):
    email, _ = register(client, "pk-pw@example.com")
    token = login(client, email)
    response = client.post(
        "/v1/auth/passkeys/register/options",
        json={"password": "not-the-password!!"},
        headers=bearer(token),
    )
    assert response.status_code == 401


def test_a_challenge_is_single_use(client):
    email, _ = register(client, "pk-replay@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    enrol(client, token, device)

    options = client.post("/v1/auth/passkeys/sign-in/options").json()
    assertion = device.get(options["options"])
    payload = {"challenge_id": options["challenge_id"], "credential": assertion}
    assert client.post("/v1/auth/passkeys/sign-in", json=payload).status_code == 200
    replay = client.post("/v1/auth/passkeys/sign-in", json=payload)
    assert replay.status_code == 400


def test_wrong_origin_is_refused(client):
    email, _ = register(client, "pk-origin@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    enrol(client, token, device)

    phisher = SoftAuthenticator(origin="https://pacestreak.example")
    phisher.key, phisher.credential_id = device.key, device.credential_id
    assert sign_in(client, phisher).status_code == 401


def test_user_verification_is_required(client):
    email, _ = register(client, "pk-uv@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    enrol(client, token, device)
    assert sign_in(client, device, verified=False).status_code == 401


def test_unknown_credential_is_refused(client):
    assert sign_in(client, SoftAuthenticator()).status_code == 401


def test_a_passkey_satisfies_two_factor(client):
    email, _ = register(client, "pk-2fa@example.com")
    token = login(client, email)
    setup = client.post("/v1/auth/2fa/setup", headers=bearer(token)).json()
    code = pyotp.TOTP(setup["secret"]).now()
    client.post(
        "/v1/auth/2fa/enable", json={"password": PASSWORD, "code": code}, headers=bearer(token)
    )
    device = SoftAuthenticator()
    enrol(client, token, device)

    response = sign_in(client, device)
    assert response.status_code == 200
    assert "access_token" in response.json()


def test_removing_requires_the_password_and_stops_sign_in(client):
    email, _ = register(client, "pk-rm@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    created = enrol(client, token, device)

    bad = client.post(
        f"/v1/auth/passkeys/{created['id']}/remove",
        json={"password": "not-the-password!!"},
        headers=bearer(token),
    )
    assert bad.status_code == 401
    ok = client.post(
        f"/v1/auth/passkeys/{created['id']}/remove",
        json={"password": PASSWORD},
        headers=bearer(token),
    )
    assert ok.status_code == 204
    assert sign_in(client, device).status_code == 401


def test_someone_elses_passkey_is_invisible(client):
    a, _ = register(client, "pk-a@example.com")
    b, _ = register(client, "pk-b@example.com")
    token_a = login(client, a)
    created = enrol(client, token_a, SoftAuthenticator())
    token_b = login(client, b)
    response = client.patch(
        f"/v1/auth/passkeys/{created['id']}", json={"name": "mine now"}, headers=bearer(token_b)
    )
    assert response.status_code == 404


def test_same_authenticator_cannot_register_twice(client):
    email, _ = register(client, "pk-dup@example.com")
    token = login(client, email)
    device = SoftAuthenticator()
    enrol(client, token, device)
    start = client.post(
        "/v1/auth/passkeys/register/options", json={"password": PASSWORD}, headers=bearer(token)
    ).json()
    assert start["options"]["excludeCredentials"][0]["id"] == bytes_to_base64url(
        device.credential_id
    )
    again = client.post(
        "/v1/auth/passkeys/register",
        json={"challenge_id": start["challenge_id"], "credential": device.create(start["options"])},
        headers=bearer(token),
    )
    assert again.status_code == 409
