"""用各工况的 Yc 上下界逐帧计算归一化进度变量 C。"""

import argparse
import json
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory

import h5py
import numpy as np


def normalize_case(case_name, profiles, bounds_path, output_root):
    output_dir = output_root / case_name

    try:
        with h5py.File(bounds_path, "r") as bounds:
            z = bounds["Z"][()]
            lower = bounds["Yc_min"][1:-1]
            span = bounds["Yc_max"][1:-1] - lower
    except (OSError, KeyError) as exc:
        raise ValueError(f"工况 {case_name} 的 Yc 上下界文件 {bounds_path}：{exc}") from exc

    invalid = np.flatnonzero(~(span > 0))
    if invalid.size:
        point = invalid[0]
        raise ValueError(f"工况 {case_name} 在 Z={z[point + 1]:.17g} 的 Yc 上下界差值不是正值：{span[point]:.17g}")

    with TemporaryDirectory(prefix=".normalizing-", dir=output_root) as temporary:
        staged = Path(temporary) / "profiles"
        staged.mkdir()
        for profile in profiles:
            try:
                output_path = staged / profile.name
                copyfile(profile, output_path)
                with h5py.File(output_path, "r+") as output:
                    # 两侧入口的 C 用 0 占位，下一步按 Z 识别入口。
                    c = np.zeros(z.size)
                    c[1:-1] = (output["Yc"][1:-1] - lower) / span
                    output.create_dataset("C", data=c).attrs["unit"] = "1"
            except (OSError, KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"工况 {case_name} 的剖面 {profile.name}：{exc}") from exc
        staged.rename(output_dir)

    return z.size, output_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", help="工况目录名，可重复传入，默认处理所有已插值工况")
    args = parser.parse_args()

    case_root = Path.cwd()
    tabulation_root = case_root / "C-tabulation"
    input_root = tabulation_root / "02-z_interpolated"
    bounds_root = tabulation_root / "03-yc_bounds"
    output_root = tabulation_root / "04-c_normalized"
    try:
        available = {}
        for case_dir in sorted(input_root.iterdir()):
            if not case_dir.is_dir():
                continue
            profiles = sorted(path for path in case_dir.glob("*.h5") if path.is_file())
            if profiles:
                available[case_dir.name] = profiles
        names = list(dict.fromkeys(args.case)) if args.case else list(available)
        if not names:
            raise ValueError(f"没有可归一化的插值工况：{input_root}")
        missing = [name for name in names if name not in available]
        if missing:
            raise ValueError(f"找不到已有插值剖面的工况：{', '.join(missing)}")

        output_root.mkdir(parents=True, exist_ok=True)
        completed = []
        for name in names:
            profiles = available[name]
            z_count, output_dir = normalize_case(name, profiles, bounds_root / name / "yc_bounds.h5", output_root)
            completed.append({"case_name": name, "profile_count": len(profiles), "z_count": z_count,
                              "output_dir": output_dir.relative_to(case_root).as_posix()})
    except (OSError, ValueError) as exc:
        parser.exit(1, f"计算 C 失败：{exc}\n")
    print(json.dumps({"cases": completed}))


if __name__ == "__main__":
    main()
