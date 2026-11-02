"""Deterministic synthetic inputs; no downloaded or organization data."""
import json
import random


def ndjson(batch_id, operations, *, crlf=False):
    separator = "\r\n" if crlf else "\n"
    return separator.join(json.dumps(row, ensure_ascii=False) for row in
                          [{"type": "batch", "batchId": batch_id}, *operations]) + separator


def upsert(source, title, body):
    return {"type": "upsert", "source": source, "title": title, "body": body}


def corpus(seed=17041, count=12):
    rng = random.Random(seed)
    colors = ["amber", "cobalt", "umber", "violet"]
    return [upsert(f"local/record-{index:03d}.md", f"Field record {index:03d}",
                   f"# Synthetic field record\nCafé 🧭 東京 e\u0301\n"
                   f"archive {rng.choice(colors)} marker{index:03d} fern.\n"
                   "These notes describe imaginary stones and plants.\n")
            for index in range(count)]


def unicode_body():
    return "# Σημειώσεις\r\nCafé 🧭 東京 e\u0301\nBefore needle after.\n<em>literal</em>\n"


def byte_slice(body, start, end):
    return body.encode("utf-8")[start:end].decode("utf-8", errors="strict")


if __name__ == "__main__":
    print(ndjson("local-corpus-v1", corpus()), end="")
