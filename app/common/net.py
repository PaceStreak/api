"""Guards against pointing a server-side request at our own network.

The push endpoint is a URL the browser hands us and the worker later POSTs to.
Nothing stops a crafted request from registering an endpoint that points at an
internal address - the VM's metadata server, localhost, another service on the
private network - turning "send this user a push" into a blind SSRF. We reject
any endpoint that resolves to a non-public address before storing it.
"""

import ipaddress
import socket
from urllib.parse import urlsplit


def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # is_global is false for private, loopback, link-local (incl. 169.254.x,
    # the cloud metadata address), reserved and unspecified ranges.
    return addr.is_global and not addr.is_multicast


def is_safe_public_url(url: str) -> bool:
    """True only if `url` is https and every address its host resolves to is a
    public, routable IP. Fails closed on a malformed URL or a lookup error."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return False
    # A literal IP host is checked directly; a name is resolved and every
    # answer must be public, so a split-horizon name can't sneak one in.
    try:
        ipaddress.ip_address(parts.hostname)
        return _is_public_ip(parts.hostname)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror, UnicodeError, OSError:
        return False
    if not infos:
        return False
    return all(_is_public_ip(info[4][0]) for info in infos)
