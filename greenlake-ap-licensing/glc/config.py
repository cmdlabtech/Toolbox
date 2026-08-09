"""Configuration loading: config.ini with environment-variable overrides."""

import configparser
import os


class ConfigError(Exception):
    pass


def _clean(value):
    """Strip inline ';' comments and whitespace from an ini value."""
    if value is None:
        return None
    value = value.split(";")[0].strip()
    return value or None


def load_config(path):
    """Return a dict with 'greenlake' and 'central' sections.

    Environment variables win over the ini file so credentials can be
    injected without writing them to disk.
    """
    parser = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
    if path and os.path.exists(path):
        parser.read(path)

    def get(section, key, env, default=None):
        env_val = os.environ.get(env)
        if env_val:
            return env_val.strip()
        if parser.has_option(section, key):
            return _clean(parser.get(section, key)) or default
        return default

    cfg = {
        "greenlake": {
            "client_id": get("greenlake", "client_id", "GL_CLIENT_ID"),
            "client_secret": get("greenlake", "client_secret", "GL_CLIENT_SECRET"),
            "sso_url": get(
                "greenlake", "sso_url", "GL_SSO_URL",
                "https://sso.common.cloud.hpe.com/as/token.oauth2",
            ),
            "api_base": get(
                "greenlake", "api_base", "GL_API_BASE",
                "https://global.api.greenlake.hpe.com",
            ),
        },
        "central": {
            "mode": (get("central", "mode", "CENTRAL_MODE", "classic") or "classic").lower(),
            "base_url": get("central", "base_url", "CENTRAL_BASE_URL"),
            "access_token": get("central", "access_token", "CENTRAL_ACCESS_TOKEN"),
            "client_id": get("central", "client_id", "CENTRAL_CLIENT_ID"),
            "client_secret": get("central", "client_secret", "CENTRAL_CLIENT_SECRET"),
            "refresh_token": get("central", "refresh_token", "CENTRAL_REFRESH_TOKEN"),
        },
    }
    return cfg


def validate_config(cfg):
    """Raise ConfigError with a helpful message if required values are missing."""
    problems = []
    gl = cfg["greenlake"]
    if not gl["client_id"] or not gl["client_secret"]:
        problems.append(
            "GreenLake client_id/client_secret missing "
            "([greenlake] section or GL_CLIENT_ID / GL_CLIENT_SECRET)."
        )
    ce = cfg["central"]
    if ce["mode"] not in ("classic", "new"):
        problems.append(
            f"Unknown central mode '{ce['mode']}': use 'classic' or 'new'."
        )
    if not ce["base_url"]:
        problems.append(
            "Aruba Central base_url missing ([central] section or CENTRAL_BASE_URL)."
        )
    if ce["mode"] == "classic":
        has_token = bool(ce["access_token"])
        has_oauth = all([ce["client_id"], ce["client_secret"], ce["refresh_token"]])
        if not has_token and not has_oauth:
            problems.append(
                "Classic Central auth missing: provide either access_token "
                "(Option A) or client_id + client_secret + refresh_token "
                "(Option B)."
            )
    # mode 'new' needs no extra auth: it falls back to the GreenLake
    # credentials unless a dedicated client_id/client_secret pair is given
    if problems:
        raise ConfigError("\n".join("  - " + p for p in problems))
