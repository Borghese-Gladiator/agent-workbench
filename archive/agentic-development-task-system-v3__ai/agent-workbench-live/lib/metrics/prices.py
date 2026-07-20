"""Per-model price table loader + cost computation.

``prices.yaml`` is hand-maintained. Schema:

    schema_version: 1
    models:
      claude-opus-4-7:
        input_per_mtok: 15.00
        output_per_mtok: 75.00
        cache_read_per_mtok: 1.50
        cache_creation_per_mtok: 18.75

Unknown models emit a one-time stderr warning per model id and contribute
0.0 to the cost (no synthetic prices).
"""
from __future__ import annotations

import pathlib
import sys
from dataclasses import dataclass

from lib import yaml_io


RATE_KEYS = (
    "input_per_mtok",
    "output_per_mtok",
    "cache_read_per_mtok",
    "cache_creation_per_mtok",
)


class PricesError(ValueError):
    pass


@dataclass(frozen=True)
class Rates:
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    cache_creation_per_mtok: float


def load(path: pathlib.Path) -> dict[str, Rates]:
    """Load prices.yaml. Returns a dict ``model_id -> Rates``.

    Raises PricesError if the file is malformed (missing ``models``, negative
    rates, non-numeric values, etc).
    """
    if not path.exists():
        raise PricesError(f"prices file not found: {path}")
    raw = yaml_io.loads(path.read_text())
    if not isinstance(raw, dict):
        raise PricesError(f"prices.yaml must be a mapping, got {type(raw).__name__}")
    models = raw.get("models")
    if not isinstance(models, dict):
        raise PricesError("prices.yaml missing required key: models (map)")
    out: dict[str, Rates] = {}
    for model_id, rates in models.items():
        if not isinstance(rates, dict):
            raise PricesError(f"rates for {model_id!r} must be a mapping")
        kwargs: dict[str, float] = {}
        for key in RATE_KEYS:
            if key not in rates:
                raise PricesError(f"{model_id}: missing rate key {key!r}")
            v = rates[key]
            try:
                fv = float(v)
            except (TypeError, ValueError):
                raise PricesError(f"{model_id}.{key} must be numeric, got {v!r}")
            if fv < 0:
                raise PricesError(f"{model_id}.{key} must be >= 0, got {fv}")
            kwargs[key] = fv
        out[str(model_id)] = Rates(**kwargs)
    return out


_WARNED: set[str] = set()


def cost_usd(usage: dict, model: str, table: dict[str, Rates]) -> float:
    """Cost (USD) for one turn's usage at the given model's rates.

    Unknown ``model`` → emit a one-time stderr warning per model id and return 0.0.
    """
    rates = table.get(model)
    if rates is None:
        if model and model not in _WARNED:
            _WARNED.add(model)
            print(
                f"metrics: warning: unknown model {model!r} not in prices.yaml; "
                f"skipping cost for this turn",
                file=sys.stderr,
            )
        return 0.0
    inp = int(usage.get("input_tokens", 0) or 0)
    out = int(usage.get("output_tokens", 0) or 0)
    cr = int(usage.get("cache_read_input_tokens", 0) or 0)
    cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
    return (
        inp * rates.input_per_mtok
        + out * rates.output_per_mtok
        + cr * rates.cache_read_per_mtok
        + cc * rates.cache_creation_per_mtok
    ) / 1_000_000.0


def reset_warning_cache() -> None:
    """For tests."""
    _WARNED.clear()
