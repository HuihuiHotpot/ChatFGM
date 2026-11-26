"""将制表样本沿原剖面空间顺序插值到统一的 Z 网格。"""

import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import h5py
import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from profile_sampling import apply_crossings, first_crossings


def interpolate_profile(input_path, output_path, target_z):
    with h5py.File(input_path, "r") as source:
        crossings = first_crossings(source["Z"][()], target_z)
        with h5py.File(output_path, "x") as output:
            output.attrs.update(source.attrs)
            output.create_dataset("Z", data=target_z).attrs.update(source["Z"].attrs)
            for name, dataset in source.items():
                if name == "Z":
                    continue
                if dataset.ndim == 0:
                    source.copy(name, output)
                    continue

                interpolated = apply_crossings(dataset[()], crossings)
                output.create_dataset(name, data=interpolated).attrs.update(dataset.attrs)


def interpolate_case(case_name, profiles, output_root, target_z):
    output_dir = output_root / case_name
    if output_dir.exists():
        raise FileExistsError(f"插值结果目录已存在：{output_dir}")

    with TemporaryDirectory(prefix=".interpolating-", dir=output_root) as temporary:
        staged = Path(temporary) / "profiles"
        staged.mkdir()
        for profile in profiles:
            try:
                interpolate_profile(profile, staged / profile.name, target_z)
            except (OSError, KeyError, IndexError, TypeError, ValueError) as exc:
                raise ValueError(f"工况 {case_name} 的剖面 {profile.name}：{exc}") from exc
        staged.rename(output_dir)
    return len(profiles), output_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--z-grid", required=True, nargs="+", type=float,
                        help="从 0 到 1 严格递增的目标 Z 坐标")
    parser.add_argument("--case", action="append", help="工况目录名，可重复传入，默认处理所有已准备的工况")
    args = parser.parse_args()

    target_z = np.asarray(args.z_grid)
    if target_z.size < 2 or target_z[0] != 0 or target_z[-1] != 1 or not np.all(np.diff(target_z) > 0):
        parser.error("--z-grid 须从 0 到 1 严格递增，且至少包含两个点")

    case_root = Path.cwd()
    tabulation_root = case_root / "C-tabulation"
    input_root = tabulation_root / "01-prepared_samples"
    output_root = tabulation_root / "02-z_interpolated"
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
            raise ValueError(f"没有可插值的工况：{input_root}")
        missing = [name for name in names if name not in available]
        if missing:
            raise ValueError(f"找不到已有制表样本的工况：{', '.join(missing)}")

        output_root.mkdir(parents=True, exist_ok=True)
        completed = []
        for name in names:
            count, output_dir = interpolate_case(name, available[name], output_root, target_z)
            completed.append({"case_name": name, "profile_count": count,
                              "output_dir": output_dir.relative_to(case_root).as_posix()})
    except (OSError, ValueError) as exc:
        parser.exit(1, f"沿 Z 插值失败：{exc}\n")
    print(json.dumps({"z_count": target_z.size, "cases": completed}))


if __name__ == "__main__":
    main()
