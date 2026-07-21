from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data" / "raw"
CACHE_DIR = PROJECT_ROOT / ".cache" / "upstream"
RUNS_DIR = PROJECT_ROOT / "runs"
SUBMISSIONS_DIR = PROJECT_ROOT / "submissions"
SLICES_DIR = Path(__file__).resolve().parent / "slices"
LOCK_PATH = PROJECT_ROOT / "benchmark.lock.json"

LONGMEMEVAL_S_FILE = "longmemeval_s_cleaned.json"
LONGMEMEVAL_ORACLE_FILE = "longmemeval_oracle.json"
EVALUATOR_FILE = "evaluate_qa.py"

EXPECTED_CASES = 500
EXPECTED_ABSTENTIONS = 30
QUESTION_TYPES = {
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "knowledge-update",
    "temporal-reasoning",
}
CANONICAL_JUDGE_MODEL = "gpt-4o-2024-08-06"
