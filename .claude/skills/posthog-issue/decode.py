# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Decode the result of the posthog-issue skill's events query into files.

Usage:
    uv run --script decode.py <out-dir> <result-file>
    uv run --script decode.py <out-dir> - < result.txt

<result-file> is the result of the skill's `call --json execute-sql` query: either the
tool-results file Claude Code saved a large MCP result to, or (for a small result that came
back inline) the same text piped through stdin. The plain table form (without --json) works
too.

Writes, per event, <out-dir>/<event-uuid>/:
    logs.log     decoded app log (gzip+base64 -> text)
    config.json  redacted config overrides
    state.json   redacted state.json overrides
    meta.json    every other column (version, platform, crash_source, byte counts, ...)
and prints one summary line per event.
"""

import base64
import binascii
import gzip
import json
import sys
from pathlib import Path

# Columns the skill's SQL selects, in order. Every value is pipe-free: free-form JSON is
# base64-encoded in SQL, because PostHog returns the rows as a `|`-separated table.
COLUMNS = [
    "uuid",
    "timestamp",
    "types",
    "values_b64",
    "version",
    "platform",
    "arch",
    "agent",
    "is_development",
    "crash_source",
    "phase",
    "logs_format",
    "logs_raw_bytes",
    "logs_raw_bytes_dropped",
    "config_b64",
    "state_b64",
    "logs",
]


def fail(message: str) -> None:
    sys.exit(f"decode.py: {message}")


def table_text(raw: str) -> str:
    """The `|`-separated table, whether `raw` is the --json object or the table itself."""
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            doc = json.loads(stripped)
        except json.JSONDecodeError as e:
            fail(f"input looks like JSON but does not parse ({e}); is it truncated?")
        results = doc.get("results")
        if not isinstance(results, str):
            fail("JSON input has no string `results` field; run the query with `call --json execute-sql`")
        return results
    return stripped


def parse_rows(table: str) -> list[dict[str, str]]:
    lines = [line for line in table.splitlines() if line.strip()]
    if not lines:
        fail("empty result: no events matched (check the issue id and the timestamp window)")
    header = lines[0].split("|")
    if header != COLUMNS:
        fail(
            "unexpected columns; use the query from SKILL.md unchanged.\n"
            f"  expected: {'|'.join(COLUMNS)}\n  got:      {lines[0][:300]}"
        )
    rows = []
    for n, line in enumerate(lines[1:], start=1):
        cells = line.split("|")
        if len(cells) != len(COLUMNS):
            fail(f"row {n} has {len(cells)} fields, expected {len(COLUMNS)}; is the input truncated?")
        rows.append(dict(zip(COLUMNS, cells)))
    if not rows:
        fail("empty result: no events matched (check the issue id and the timestamp window)")
    return rows


def b64_text(value: str) -> str:
    return base64.b64decode(value).decode("utf-8", errors="replace") if value else ""


def pretty_json(text: str) -> str:
    """Pretty-print JSON text; keep it verbatim if it is not JSON (or empty)."""
    if not text:
        return "{}\n"
    try:
        return json.dumps(json.loads(text), indent=2, ensure_ascii=False) + "\n"
    except json.JSONDecodeError:
        return text + "\n"


def decode_logs(fmt: str, value: str) -> str:
    if not value or fmt in ("", "none", "null"):
        return ""
    if fmt != "gzip+base64":
        fail(f"unknown logs_format {fmt!r}; the decoder only knows gzip+base64")
    try:
        return gzip.decompress(base64.b64decode(value)).decode("utf-8", errors="replace")
    except (binascii.Error, gzip.BadGzipFile, EOFError, OSError) as e:
        fail(f"logs do not decode as gzip+base64 ({e}); the value was probably truncated")
    return ""


def scalar(value: str) -> int | bool | str | None:
    """PostHog's table renders NULL as `(null)`, booleans as True/False, ints as `299.0`."""
    if value in ("", "(null)", "null", "None"):
        return None
    if value in ("True", "true"):
        return True
    if value in ("False", "false"):
        return False
    try:
        number = float(value)
    except ValueError:
        return value
    return int(number) if number.is_integer() else value


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: decode.py <out-dir> <result-file | ->")
    out_dir = Path(sys.argv[1])
    source = sys.argv[2]
    raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")

    for row in parse_rows(table_text(raw)):
        event_dir = out_dir / row["uuid"]
        event_dir.mkdir(parents=True, exist_ok=True)

        meta: dict[str, object] = {
            k: scalar(row[k])
            for k in COLUMNS
            if k not in ("uuid", "timestamp", "types", "version", "values_b64", "config_b64", "state_b64", "logs")
        }
        meta = {"uuid": row["uuid"], "timestamp": row["timestamp"], "version": row["version"], **meta}
        try:
            meta["types"] = json.loads(row["types"])
        except json.JSONDecodeError:
            meta["types"] = row["types"]

        logs = decode_logs(row["logs_format"], row["logs"])
        dropped = meta["logs_raw_bytes_dropped"]
        if dropped and "\n" in logs:
            # The head was trimmed to fit PostHog's size cap mid-line; drop the fragment.
            logs = logs.split("\n", 1)[1]
        (event_dir / "logs.log").write_text(logs, encoding="utf-8")
        (event_dir / "config.json").write_text(pretty_json(b64_text(row["config_b64"])), encoding="utf-8")
        (event_dir / "state.json").write_text(pretty_json(b64_text(row["state_b64"])), encoding="utf-8")

        values_text = b64_text(row["values_b64"])
        try:
            messages = json.loads(values_text) if values_text else []
        except json.JSONDecodeError:
            messages = [values_text]
        meta["messages"] = messages
        (event_dir / "meta.json").write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

        line_count = logs.count("\n") + (1 if logs and not logs.endswith("\n") else 0)
        types = ",".join(meta["types"]) if isinstance(meta["types"], list) else meta["types"]
        print(
            f"{event_dir}  {row['timestamp']}  {types}  v{row['version']} {meta['platform']}"
            f"  source={meta['crash_source'] or '-'}  log_lines={line_count}"
            + (f"  head_dropped={dropped}B" if dropped else "")
        )


if __name__ == "__main__":
    main()
