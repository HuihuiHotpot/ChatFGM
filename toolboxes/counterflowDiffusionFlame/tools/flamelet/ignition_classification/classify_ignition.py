"""读取正式瞬态着火结果，生成供稳态延拓、FFM 和后处理使用的清单。"""

import argparse
import csv
import json
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile


FIELDS = ["case_name", "case_path", "ignited", "restart_file"]
FINAL_STATUS = re.compile(
    r"t=\d+(?:\.\d+)? ms, .*\bignited=(True|False), Q_steady=(True|False)(?:,|$)"
)
NUMBERED_PROFILE = re.compile(r"prof[0-9]+\.h5")


def read_case(case_root, case_dir):
    log = (case_dir / "case_status.txt").read_text(encoding="utf-8")
    last_line = log.rstrip().rsplit("\n", 1)[-1]
    status = FINAL_STATUS.match(last_line)
    if status is None:
        raise ValueError("case_status.txt 缺少可判读的末条状态记录")

    ignited_text, steady_text = status.groups()
    ignited = ignited_text == "True"
    q_steady = steady_text == "True"

    restart_file = ""
    if ignited and q_steady:
        profiles = (
            path for path in case_dir.iterdir()
            if NUMBERED_PROFILE.fullmatch(path.name) and path.is_file()
        )
        profile = max(profiles, key=lambda path: int(path.stem[4:]), default=None)
        if profile is None:
            raise ValueError("已着火且判稳的工况缺少编号剖面")
        restart_file = profile.relative_to(case_root).as_posix()

    return {
        "case_name": case_dir.name,
        "case_path": case_dir.relative_to(case_root).as_posix(),
        "ignited": ignited,
        "restart_file": restart_file,
    }


def write_status(output, rows):
    stream = NamedTemporaryFile(
        "w", encoding="utf-8-sig", newline="", dir=output.parent, delete=False
    )
    temporary = Path(stream.name)
    try:
        with stream:
            writer = csv.DictWriter(stream, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def classify_ignition(case_root):
    flamelet_root = case_root / "B-flamelet"
    formal_root = flamelet_root / "02-transient_ignition" / "formal"
    status_file = formal_root / "_status.csv"
    with status_file.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not {"case", "status"}.issubset(reader.fieldnames or ()):
            raise ValueError(f"状态表缺少 case 或 status 列：{status_file}")
        latest_status = {row["case"]: row["status"] for row in reader}

    rows = []
    unclassified_cases = 0
    for case_name, status in sorted(latest_status.items()):
        if status != "SUCCESS":
            continue
        try:
            rows.append(read_case(case_root, formal_root / case_name))
        except (OSError, ValueError) as exc:
            print(f"工况 {case_name} 无法交接：{exc}", file=sys.stderr)
            unclassified_cases += 1

    output = flamelet_root / "ignition_status.csv"
    write_status(output, rows)
    ignited_cases = sum(row["ignited"] for row in rows)
    return {
        "output_file": str(output),
        "total_cases": len(rows),
        "ignited_cases": ignited_cases,
        "unignited_cases": len(rows) - ignited_cases,
        "continuation_ready_cases": sum(bool(row["restart_file"]) for row in rows),
        "unclassified_cases": unclassified_cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-root", type=Path, default=Path.cwd(), help="算例根目录，默认当前目录")
    case_root = parser.parse_args().case_root.resolve()
    try:
        result = classify_ignition(case_root)
    except (OSError, ValueError, csv.Error) as exc:
        parser.exit(1, f"着火判定失败：{exc}\n")
    print(json.dumps(result))
    return int(result["unclassified_cases"] > 0)


if __name__ == "__main__":
    sys.exit(main())
