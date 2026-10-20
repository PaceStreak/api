#!/usr/bin/env python3
"""Copy the production D1 database into Postgres as an off-host backup.

    python3 scripts/backup-to-neon.py dump.sql "$NEON_DATABASE_URL"   # from a `wrangler d1 export` file
    python3 scripts/backup-to-neon.py --api "$NEON_DATABASE_URL"      # straight from D1's query API

`--api` reads every table through the D1 REST query endpoint (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
D1_DATABASE_ID in the environment). It needs only a token allowed to query D1, where the export endpoint refused
an account-scoped D1 Edit token. Either way the data lands in an in-memory SQLite, then every table is copied into
the Postgres schema `d1_backup`. The copy is built in `d1_backup_new` and swapped
in at the end in one transaction, so a failed run leaves the previous night's
backup untouched. Column types follow SQLite affinity (INTEGER -> bigint, REAL ->
double precision, BLOB -> bytea, everything else -> text); constraints and
indexes are not copied, since this is a restorable copy, not a live database.

Needs only the standard library and `psql` on PATH. Prints counts, never data.
"""

import csv
import io
import json
import os
import sqlite3
import urllib.request
import subprocess
import sys

NEW, LIVE = "d1_backup_new", "d1_backup"


def pg_type(decl: str) -> str:
    d = (decl or "").upper()
    if "INT" in d:
        return "bigint"
    if any(k in d for k in ("REAL", "FLOA", "DOUB")):
        return "double precision"
    if "BLOB" in d:
        return "bytea"
    return "text"


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def cell(v):
    if v is None:
        return r"\N"
    if isinstance(v, bytes):
        return "\\x" + v.hex()
    return v


PAGE = 2000


def d1(sql: str) -> list[dict]:
    env = os.environ
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{env['CLOUDFLARE_ACCOUNT_ID']}"
        f"/d1/database/{env['D1_DATABASE_ID']}/query"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": f"Bearer {env['CLOUDFLARE_API_TOKEN']}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.load(res)
    if not body.get("success"):
        raise SystemExit(f"D1 query failed: {body.get('errors')}")
    return body["result"][0]["results"]


def from_api(db: sqlite3.Connection) -> None:
    tables = d1(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name"
    )
    for t in tables:
        db.execute(t["sql"])
        cols = [c["name"] for c in d1(f"SELECT name FROM pragma_table_info('{t['name']}')")]
        sel = ", ".join(q(c) for c in cols)
        offset = 0
        while True:
            rows = d1(f"SELECT {sel} FROM {q(t['name'])} ORDER BY rowid LIMIT {PAGE} OFFSET {offset}")
            db.executemany(
                f"INSERT INTO {q(t['name'])} ({sel}) VALUES ({', '.join('?' for _ in cols)})",
                [[r[c] for c in cols] for r in rows],
            )
            if len(rows) < PAGE:
                break
            offset += PAGE


def main(dump_path: str, url: str) -> None:
    db = sqlite3.connect(":memory:")
    if dump_path == "--api":
        from_api(db)
    else:
        with open(dump_path, encoding="utf-8") as f:
            db.executescript(f.read())

    tables = [
        r[0]
        for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
        )
    ]

    script = io.StringIO()
    script.write("\\set ON_ERROR_STOP on\nSET client_min_messages = warning;\nBEGIN;\n")
    script.write(f"DROP SCHEMA IF EXISTS {NEW} CASCADE;\nCREATE SCHEMA {NEW};\n")
    counts = []
    for t in tables:
        cols = list(db.execute(f"PRAGMA table_info({q(t)})"))
        names = [c[1] for c in cols]
        defs = ", ".join(f"{q(c[1])} {pg_type(c[2])}" for c in cols)
        script.write(f"CREATE TABLE {NEW}.{q(t)} ({defs});\n")
        rows = db.execute(f"SELECT {', '.join(q(n) for n in names)} FROM {q(t)}").fetchall()
        counts.append((t, len(rows)))
        if not rows:
            continue
        script.write(
            f"COPY {NEW}.{q(t)} ({', '.join(q(n) for n in names)}) FROM STDIN WITH (FORMAT csv, NULL '\\N');\n"
        )
        w = csv.writer(script, lineterminator="\n")
        for r in rows:
            w.writerow([cell(v) for v in r])
        script.write("\\.\n")
    script.write(
        f"DROP SCHEMA IF EXISTS {LIVE} CASCADE;\nALTER SCHEMA {NEW} RENAME TO {LIVE};\n"
        f"COMMENT ON SCHEMA {LIVE} IS 'Nightly copy of the production D1 database';\nCOMMIT;\n"
    )

    subprocess.run(
        ["psql", url, "--quiet", "--no-psqlrc"],
        input=script.getvalue(),
        text=True,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    print(f"{len(tables)} tables, {sum(n for _, n in counts)} rows copied to schema {LIVE}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: backup-to-neon.py DUMP.sql|--api POSTGRES_URL")
    main(sys.argv[1], sys.argv[2])
