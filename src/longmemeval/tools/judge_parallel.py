from __future__ import annotations

import argparse
import importlib.util
import json
import os
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import openai
from openai import OpenAI

from longmemeval.constants import (
    CACHE_DIR,
    CANONICAL_JUDGE_MODEL,
    DATA_DIR,
    EVALUATOR_FILE,
    LONGMEMEVAL_ORACLE_FILE,
)
from longmemeval.data import verify_data
from longmemeval.runner import resolve_run_path, write_official_predictions
from longmemeval.settings import load_environment
from longmemeval.utils import read_json, read_jsonl, sha256_file, utc_now, write_json

PromptBuilder = Callable[[str, str, str, str, bool], str]


def _load_prompt_builder(path: Path) -> PromptBuilder:
    spec = importlib.util.spec_from_file_location("pinned_longmemeval_evaluator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import pinned evaluator: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    builder = getattr(module, "get_anscheck_prompt", None)
    if not callable(builder):
        raise RuntimeError("pinned evaluator has no callable get_anscheck_prompt")
    return builder


def _retry_delay(error: Exception, attempt: int) -> float | None:
    retryable = isinstance(
        error,
        (
            openai.APIConnectionError,
            openai.APITimeoutError,
            openai.RateLimitError,
            openai.InternalServerError,
        ),
    )
    if isinstance(error, openai.APIStatusError) and error.status_code >= 500:
        retryable = True
    if not retryable:
        return None
    return min(60.0, float(2**attempt))


def _judge_one(
    *,
    index: int,
    prediction: dict[str, Any],
    reference: dict[str, Any],
    prompt_builder: PromptBuilder,
    client: OpenAI,
    artifact_dir: Path,
) -> tuple[int, dict[str, Any]]:
    question_id = str(prediction["question_id"])
    prompt = prompt_builder(
        str(reference["question_type"]),
        str(reference["question"]),
        str(reference["answer"]),
        str(prediction["hypothesis"]),
        "_abs" in question_id,
    )
    last_error: Exception | None = None
    for attempt in range(7):
        started = time.perf_counter()
        try:
            completion = client.chat.completions.create(
                model=CANONICAL_JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                n=1,
                temperature=0,
                max_tokens=10,
                timeout=300,
            )
            content = completion.choices[0].message.content or ""
            response = content.strip()
            label = "yes" in response.lower()
            usage = completion.usage
            judgment = {
                **prediction,
                "autoeval_label": {
                    "model": CANONICAL_JUDGE_MODEL,
                    "label": label,
                },
            }
            write_json(
                artifact_dir / f"{question_id}.json",
                {
                    "question_id": question_id,
                    "model": CANONICAL_JUDGE_MODEL,
                    "temperature": 0,
                    "max_tokens": 10,
                    "prompt": prompt,
                    "response": response,
                    "label": label,
                    "request_id": completion.id,
                    "usage": {
                        "prompt_tokens": usage.prompt_tokens if usage else None,
                        "completion_tokens": usage.completion_tokens if usage else None,
                        "total_tokens": usage.total_tokens if usage else None,
                    },
                    "latency_ms": (time.perf_counter() - started) * 1000,
                    "retry_count": attempt,
                },
            )
            return index, judgment
        except Exception as error:
            last_error = error
            delay = _retry_delay(error, attempt)
            if delay is None or attempt == 6:
                break
            time.sleep(delay)
    if last_error is None:
        raise RuntimeError(f"judge failed without an exception for {question_id}")
    raise RuntimeError(f"judge failed for {question_id}: {last_error}") from last_error


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Run the checksum-pinned LongMemEval judge prompt concurrently and retain "
            "per-case prompts, responses, usage, request IDs, latency, and retries."
        )
    )
    parser.add_argument("--run", required=True)
    parser.add_argument("--concurrency", type=int, default=64)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 256:
        raise ValueError("--concurrency must be in 1..256")

    load_environment()
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for canonical judging")
    hashes = verify_data()
    evaluator = CACHE_DIR / EVALUATOR_FILE
    prompt_builder = _load_prompt_builder(evaluator)
    run_path = resolve_run_path(args.run)
    manifest_path = run_path / "manifest.json"
    manifest = read_json(manifest_path)
    if manifest.get("status") != "completed":
        raise ValueError("run must be complete before judging")
    judgments_path = run_path / "judgments.jsonl"
    if judgments_path.exists():
        raise FileExistsError(f"judgments already exist: {judgments_path}")

    prediction_path = write_official_predictions(run_path)
    predictions = read_jsonl(prediction_path)
    references = {
        str(item["question_id"]): item
        for item in read_json(DATA_DIR / LONGMEMEVAL_ORACLE_FILE)
    }
    if len(predictions) != int(manifest["selected_count"]):
        raise ValueError(
            f"expected {manifest['selected_count']} predictions, found {len(predictions)}"
        )
    artifact_dir = run_path / "judge-artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=False)
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0)
    results: list[dict[str, Any] | None] = [None] * len(predictions)
    started = time.perf_counter()

    print(
        json.dumps(
            {
                "event": "start",
                "run_id": args.run,
                "cases": len(predictions),
                "concurrency": args.concurrency,
                "model": CANONICAL_JUDGE_MODEL,
                "evaluator_sha256": sha256_file(evaluator),
            }
        ),
        flush=True,
    )
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures: list[Future[tuple[int, dict[str, Any]]]] = []
        for index, prediction in enumerate(predictions):
            question_id = str(prediction["question_id"])
            reference = references.get(question_id)
            if reference is None:
                raise ValueError(f"oracle is missing {question_id}")
            futures.append(
                executor.submit(
                    _judge_one,
                    index=index,
                    prediction=prediction,
                    reference=reference,
                    prompt_builder=prompt_builder,
                    client=client,
                    artifact_dir=artifact_dir,
                )
            )
        for completed, future in enumerate(as_completed(futures), start=1):
            index, judgment = future.result()
            results[index] = judgment
            if completed % 20 == 0 or completed == len(futures):
                elapsed = time.perf_counter() - started
                print(
                    json.dumps(
                        {
                            "event": "progress",
                            "completed": completed,
                            "total": len(futures),
                            "elapsed_s": round(elapsed, 1),
                            "rate_per_min": round(completed / elapsed * 60, 1),
                        }
                    ),
                    flush=True,
                )

    if any(result is None for result in results):
        raise RuntimeError("parallel judge lost one or more results")
    with judgments_path.open("w") as handle:
        for result in results:
            handle.write(json.dumps(result, sort_keys=True) + "\n")

    manifest["judging"] = {
        "provider": "openai",
        "model": CANONICAL_JUDGE_MODEL,
        "temperature": 0,
        "upstream_evaluator": EVALUATOR_FILE,
        "upstream_evaluator_sha256": hashes[EVALUATOR_FILE],
        "execution": "parallel_exact_pinned_prompt",
        "concurrency": args.concurrency,
        "artifacts": str(artifact_dir.relative_to(run_path)),
        "completed_at": utc_now(),
        "count": len(results),
    }
    manifest["updated_at"] = utc_now()
    write_json(manifest_path, manifest)
    correct = sum(
        1
        for result in results
        if result is not None and result["autoeval_label"]["label"]
    )
    print(
        json.dumps(
            {
                "event": "done",
                "run_id": args.run,
                "correct": correct,
                "count": len(results),
                "accuracy": correct / len(results),
                "elapsed_s": round(time.perf_counter() - started, 1),
                "judgments": str(judgments_path),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
