"""按工况和目标 Z 点汇总插值剖面的 Yc 上下界。"""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import h5py
import numpy as np


def compute_case_bounds(case_name, profiles, output_root):
    output_dir = output_root / case_name
    if output_dir.exists():
        raise FileExistsError(f"Yc 上下界结果目录已存在：{output_dir}")

    for index, profile in enumerate(profiles):
        try:
            with h5py.File(profile, "r") as source:
                yc = source["Yc"][()]
                if index == 0:
                    z = source["Z"][()]
                    z_attrs = dict(source["Z"].attrs)
                    yc_attrs = dict(source["Yc"].attrs)
                    lower = yc.copy()
                    upper = yc.copy()
                else:
                    np.minimum(lower, yc, out=lower)
                    np.maximum(upper, yc, out=upper)
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"工况 {case_name} 的剖面 {profile.name}：{exc}") from exc

    with TemporaryDirectory(prefix=".bounding-", dir=output_root) as temporary:
        staged = Path(temporary) / "bounds"
        staged.mkdir()
        with h5py.File(staged / "yc_bounds.h5", "x") as output:
            output.create_dataset("Z", data=z).attrs.update(z_attrs)
            output.create_dataset("Yc_min", data=lower).attrs.update(yc_attrs)
            output.create_dataset("Yc_max", data=upper).attrs.update(yc_attrs)
        staged.rename(output_dir)

    return z.size, output_dir / "yc_bounds.h5"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", help="工况目录名，可重复传入，默认处理所有已插值工况")
    args = parser.parse_args()

    case_root = Path.cwd()
    tabulation_root = case_root / "C-tabulation"
    input_root = tabulation_root / "02-z_interpolated"
    output_root = tabulation_root / "03-yc_bounds"
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
            raise ValueError(f"没有可汇总的插值工况：{input_root}")
        missing = [name for name in names if name not in available]
        if missing:
            raise ValueError(f"找不到已有插值剖面的工况：{', '.join(missing)}")

        output_root.mkdir(parents=True, exist_ok=True)
        completed = []
        for name in names:
            profiles = available[name]
            z_count, output_file = compute_case_bounds(name, profiles, output_root)
            completed.append({"case_name": name, "profile_count": len(profiles), "z_count": z_count,
                              "output_file": output_file.relative_to(case_root).as_posix()})
    except (OSError, TypeError, ValueError) as exc:
        parser.exit(1, f"计算 Yc 上下界失败：{exc}\n")
    print(json.dumps({"cases": completed}))


if __name__ == "__main__":
    main()
