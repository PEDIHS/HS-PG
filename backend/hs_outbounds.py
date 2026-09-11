"""Pure Xray WARP configuration builder with scoped routing and optimistic revisions."""

from __future__ import annotations
import base64
import configparser
import hashlib
import ipaddress
import json
import re
from copy import deepcopy


def revision(config):
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def wireguard_config(text):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        parser.read_string(text)
    except configparser.Error as exc:
        raise ValueError("Invalid WireGuard profile format") from exc
    if set(parser.sections()) != {"Interface", "Peer"}:
        raise ValueError(
            "Import a WireGuard profile with exactly one Interface and Peer"
        )
    private = parser["Interface"].get("PrivateKey", "").strip()
    public = parser["Peer"].get("PublicKey", "").strip()
    for key in (private, public):
        try:
            valid = len(base64.b64decode(key, validate=True)) == 32
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("WireGuard keys must be base64-encoded 32-byte keys")
    addresses = [
        str(ipaddress.ip_interface(v.strip()))
        for v in parser["Interface"].get("Address", "").split(",")
        if v.strip()
    ]
    if not addresses:
        raise ValueError("WireGuard interface address is required")
    endpoint = parser["Peer"].get("Endpoint", "").strip()
    if not re.fullmatch(r"(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d{1,5}", endpoint):
        raise ValueError("Invalid WireGuard peer endpoint")
    if not 1 <= int(endpoint.rsplit(":", 1)[1]) <= 65535:
        raise ValueError("Invalid WireGuard peer port")
    allowed = [
        str(ipaddress.ip_network(v.strip(), strict=False))
        for v in parser["Peer"].get("AllowedIPs", "0.0.0.0/0,::/0").split(",")
    ]
    mtu = int(parser["Interface"].get("MTU", "1280"))
    if not 1280 <= mtu <= 1500:
        raise ValueError("MTU must be between 1280 and 1500")
    return dict(
        secretKey=private,
        address=addresses,
        peers=[dict(publicKey=public, endpoint=endpoint, allowedIPs=allowed)],
        mtu=mtu,
    )


def add_warp(config, profile, tag, domains=None, inbounds=None, reserved=None):
    if not re.fullmatch(r"hs-warp-[a-zA-Z0-9_-]{1,48}", tag):
        raise ValueError("WARP tag must start with hs-warp- followed by a short name")
    output = deepcopy(config)
    if any(o.get("tag") == tag for o in output.get("outbounds", [])):
        raise ValueError("Outbound tag already exists")
    domains = domains or []
    inbounds = inbounds or []
    if not domains and not inbounds:
        raise ValueError("Choose domains or inbounds to route through WARP")
    known = {i.get("tag") for i in output.get("inbounds", [])}
    if any(v not in known for v in inbounds):
        raise ValueError("Selected inbound is absent from this Core")
    if any(
        not isinstance(v, str) or len(v) > 253 or any(c.isspace() for c in v)
        for v in domains
    ):
        raise ValueError("Invalid routing domain")
    settings = wireguard_config(profile)
    if reserved is not None:
        if len(reserved) != 3 or any(
            type(x) != int or not 0 <= x <= 255 for x in reserved
        ):
            raise ValueError("Reserved must contain three bytes")
        settings["reserved"] = reserved
    output.setdefault("outbounds", []).append(
        dict(tag=tag, protocol="wireguard", settings=settings)
    )
    rule = dict(type="field", outboundTag=tag)
    if domains:
        rule["domain"] = domains
    if inbounds:
        rule["inboundTag"] = inbounds
    output.setdefault("routing", {}).setdefault("rules", []).insert(0, rule)
    return output
