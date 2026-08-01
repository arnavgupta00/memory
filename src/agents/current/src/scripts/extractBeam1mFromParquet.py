from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess

import pyarrow.parquet as pq


OFFICIAL_PARQUET_SHA256 = "41b5acbbb55a586b1305514ef9d9fb03365d9b3331b598a1c2dd7603d93ef533"
SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def without_null_fields(value):
    if isinstance(value, dict):
        return {key: without_null_fields(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [without_null_fields(item) for item in value]
    return value


def convert_chat(batches: list[list[dict]]) -> list[dict]:
    output = []
    for batch_index, batch in enumerate(batches, start=1):
        turns = []
        current = []
        time_anchor = None
        for raw_message in batch:
            message = without_null_fields(raw_message)
            if message.get("question_type") == "main_question" and current:
                if "time_anchor" in message:
                    time_anchor = message["time_anchor"]
                turns.append(current)
                current = []
            current.append(message)
        turns.append(current)
        output.append({
            "batch_number": batch_index,
            "turns": turns,
            "time_anchor": time_anchor,
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a frozen BEAM-1M slice from official parquet.")
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--beam-repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    parquet = args.parquet.resolve()
    manifest_path = args.manifest.resolve()
    beam_repo = args.beam_repo.resolve()
    output = args.out.resolve()
    parquet_hash = sha256(parquet)
    if parquet_hash != OFFICIAL_PARQUET_SHA256:
        raise ValueError("BEAM-1M parquet does not match the official Hugging Face LFS object")
    commit = subprocess.check_output(
        ["git", "-C", str(beam_repo), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != SOURCE_COMMIT:
        raise ValueError(f"BEAM source checkout must be pinned to {SOURCE_COMMIT}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    selected = {str(value) for value in manifest["conversation_ids"]}
    table = pq.read_table(parquet)
    rows = {row["conversation_id"]: row for row in table.to_pylist()}
    missing = selected - rows.keys()
    if missing:
        raise ValueError(f"official parquet is missing conversations: {sorted(missing)}")

    output.mkdir(parents=True, exist_ok=True)
    topics = subprocess.check_output(
        ["git", "-C", str(beam_repo), "show", f"{SOURCE_COMMIT}:chats/1M/topics.json"]
    )
    (output / "topics.json").write_bytes(topics)
    generated = {"topics.json": sha256(output / "topics.json")}

    for conversation_id in sorted(selected, key=int):
        row = rows[conversation_id]
        directory = output / conversation_id
        probes_directory = directory / "probing_questions"
        probes_directory.mkdir(parents=True, exist_ok=True)
        chat_path = directory / "chat.json"
        probes_path = probes_directory / "probing_questions.json"
        chat_path.write_text(
            json.dumps(convert_chat(row["chat"]), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        probes = ast.literal_eval(row["probing_questions"])
        probes_path.write_text(
            json.dumps(probes, ensure_ascii=False, indent=4) + "\n",
            encoding="utf-8",
        )
        generated[f"{conversation_id}/chat.json"] = sha256(chat_path)
        generated[f"{conversation_id}/probing_questions/probing_questions.json"] = sha256(probes_path)

    provenance = {
        "schema_version": 1,
        "source": "https://huggingface.co/datasets/Mohammadta/BEAM",
        "tier": "1M",
        "parquet_path": str(parquet),
        "parquet_sha256": parquet_hash,
        "official_source_commit": SOURCE_COMMIT,
        "canary_manifest_path": str(manifest_path),
        "generated_file_sha256": generated,
        "encoding_note": "Semantic official records re-encoded as JSON; whitespace may differ from repository samples.",
    }
    (output / "source-provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "output": str(output),
        "conversations": sorted(int(value) for value in selected),
        "parquet_sha256": parquet_hash,
        "generated_files": len(generated),
    }, indent=2))


if __name__ == "__main__":
    main()
