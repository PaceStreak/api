import secrets

# No 0/O, 1/l/I: invite codes get read aloud across a gym floor.
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def invite_code(length: int = 8) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))
