"""扫描一个算例的 Stage B 产物，生成按工况组织的火焰面剖面清单。"""

import argparse
import csv
import json
import math
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

import h5py


NUMBERED_PROFILE = re.compile(r"prof([0-9]+)\.h5")
CONTINUATION_PROFILE = re.compile(r"prof_eps([0-9]+)\.h5")


def mixing_line_profiles(directory):
    final_profile = directory / "prof000001.h5"
    return [{"file": final_profile.name}] if final_profile.is_file() else []


def timed_profiles(directory):
    profiles = []
    for path in directory.iterdir():
        match = NUMBERED_PROFILE.fullmatch(path.name)
        if not match or not path.is_file():
            continue
        try:
            with h5py.File(path, "r") as profile:
                time_s = float(profile["t"][()])
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"无法读取剖面的积分时间：{path}。{exc}") from exc
        if not math.isfinite(time_s):
            raise ValueError(f"剖面的积分时间不是有限值：{path}")
        profiles.append((int(match[1]), {"file": path.name, "time_s": time_s}))
    profiles.sort(key=lambda entry: (entry[0], entry[1]["file"]))
    return [profile for _, profile in profiles]


def continuation_profiles(directory):
    profiles = []
    for path in directory.iterdir():
        match = CONTINUATION_PROFILE.fullmatch(path.name)
        if match and path.is_file():
            profiles.append({"file": path.name, "target_strain_rate_s_inv": int(match[1])})
    return sorted(profiles, key=lambda profile: profile["target_strain_rate_s_inv"], reverse=True)


def read_ignition_status(path):
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        states = {"true": True, "false": False}
        return {row["case_name"]: states.get(row["ignited"].strip().lower())
                for row in csv.DictReader(stream)}


def collect(case_root):
    flamelet = case_root / "B-flamelet"
    if not flamelet.is_dir():
        raise ValueError(f"找不到火焰面结果目录：{flamelet}")
    steps = (
        ("nonreactive_mixing_line", "01-nonreactive_mixing_line", mixing_line_profiles),
        ("transient_ignition", "02-transient_ignition/formal", timed_profiles),
        ("steady_flame_continuation", "03-steady_flame_continuation", continuation_profiles),
        ("frozen_flamelet", "04-frozen_flamelet/ffm", timed_profiles),
    )
    cases = {}
    for step, relative_dir, read_profiles in steps:
        step_dir = flamelet / relative_dir
        if not step_dir.is_dir():
            continue
        for directory in step_dir.iterdir():
            if directory.is_dir() and (profiles := read_profiles(directory)):
                cases.setdefault(directory.name, {})[step] = {
                    "directory": directory.relative_to(case_root).as_posix(),
                    "profiles": profiles,
                }

    ignited = read_ignition_status(flamelet / "ignition_status.csv")
    return {"cases": [
        {"case_name": name, "ignited": ignited.get(name), "results": results}
        for name, results in sorted(cases.items())
    ]}


def write_manifest(path, manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False)
    temporary = Path(stream.name)
    try:
        with stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-root", type=Path, default=Path.cwd(), help="算例根目录，默认当前目录")
    case_root = parser.parse_args().case_root.resolve()
    output = case_root / "B-flamelet" / "05-postprocess" / "flamelet_manifest.json"
    try:
        manifest = collect(case_root)
        write_manifest(output, manifest)
    except (OSError, ValueError, KeyError, csv.Error) as exc:
        parser.exit(1, f"生成火焰面结果清单失败：{exc}\n")
    print(json.dumps({"output_file": str(output), "total_cases": len(manifest["cases"])}))


if __name__ == "__main__":
    main()
