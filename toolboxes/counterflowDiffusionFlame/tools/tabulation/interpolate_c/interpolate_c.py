"""在固定 Z 点沿原始帧顺序插值，每个目标 C 保存一条剖面。"""

import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import h5py
import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from profile_sampling import profile_order


def read_profiles(profiles):
    for frame, profile in enumerate(profiles):
        try:
            with h5py.File(profile, "r") as source:
                if frame == 0:
                    z = source["Z"][()]
                    attrs = {name: dict(dataset.attrs) for name, dataset in source.items()}
                    fields = {name: [] for name in source if name != "Z"}
                for name, values in fields.items():
                    values.append(source[name][()])
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"剖面 {profile.name}：{exc}") from exc
    return z, {name: np.stack(values) for name, values in fields.items()}, attrs


def first_crossings(source_c, target_c, z):
    """按帧查找首次到达目标 C 的相邻样本。"""
    # 与沿 Z 插值一样，用累计极值定位，权重取自原始相邻样本。
    downward = np.searchsorted(-np.minimum.accumulate(source_c), -target_c)
    upward = np.searchsorted(np.maximum.accumulate(source_c), target_c)
    second = np.where(target_c < source_c[0], downward, upward)
    missing = np.flatnonzero(second == source_c.size)
    if missing.size:
        raise ValueError(f"Z={z:.17g} 的剖面序列未经过目标 C={target_c[missing[0]]:.17g}")

    between = source_c[second] != target_c
    first = second - between
    weight = np.zeros_like(target_c)
    start, end = source_c[first[between]], source_c[second[between]]
    weight[between] = (target_c[between] - start) / (end - start)
    return first, second, weight


def interpolate_case(case_name, profiles, output_root, target_c):
    profiles = sorted(profiles, key=profile_order)
    z, fields, attrs = read_profiles(profiles)
    source_c = fields.pop("C")
    columns = np.arange(z.size)
    first = np.zeros((target_c.size, z.size), dtype=np.intp)
    second = np.zeros_like(first)
    weights = np.zeros_like(first, dtype=float)
    # 两侧入口的帧号固定为 0，随目标 C 复制首帧的完整入口值。
    for iz in range(1, z.size - 1):
        first[:, iz], second[:, iz], weights[:, iz] = first_crossings(source_c[:, iz], target_c, z[iz])

    # 每帧的标量字段供该帧所有 Z 点使用，逐点字段把帧轴移到 Z 轴前。
    fields = {
        name: np.broadcast_to(values[:, None], source_c.shape) if values.ndim == 1
        else np.moveaxis(values, 0, -2)
        for name, values in fields.items()
    }
    output_dir = output_root / case_name
    with TemporaryDirectory(prefix=".interpolating-", dir=output_root) as temporary:
        staged = Path(temporary) / "profiles"
        staged.mkdir()
        for ic, c in enumerate(target_c):
            between = first[ic] != second[ic]
            with h5py.File(staged / f"prof_c{ic:06d}.h5", "x") as output:
                output.create_dataset("Z", data=z).attrs.update(attrs["Z"])
                output.create_dataset("C", data=c).attrs.update(attrs["C"])
                for name, values in fields.items():
                    dtype = np.result_type(values.dtype, np.float64)
                    result = values[..., first[ic], columns].astype(dtype, copy=False)
                    after = values[..., second[ic, between], columns[between]]
                    result[..., between] += weights[ic, between] * (after - result[..., between])
                    output.create_dataset(name, data=result).attrs.update(attrs[name])
        staged.rename(output_dir)
    return z.size, output_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--c-grid", required=True, nargs="+", type=float,
                        help="从 0 到 1 严格递增的目标 C 坐标")
    parser.add_argument("--case", action="append", help="工况目录名，可重复传入，默认处理所有已归一化的工况")
    args = parser.parse_args()

    target_c = np.asarray(args.c_grid)
    if target_c.size < 2 or target_c[0] != 0 or target_c[-1] != 1 or not np.all(np.diff(target_c) > 0):
        parser.error("--c-grid 须从 0 到 1 严格递增，且至少包含两个点")

    case_root = Path.cwd()
    tabulation_root = case_root / "C-tabulation"
    input_root = tabulation_root / "04-c_normalized"
    output_root = tabulation_root / "05-c_interpolated"
    try:
        available = {}
        for case_dir in sorted(input_root.iterdir()):
            if not case_dir.is_dir():
                continue
            profiles = [path for path in case_dir.glob("*.h5") if path.is_file()]
            if profiles:
                available[case_dir.name] = profiles
        names = list(dict.fromkeys(args.case)) if args.case else list(available)
        if not names:
            raise ValueError(f"没有可插值的归一化工况：{input_root}")
        missing = [name for name in names if name not in available]
        if missing:
            raise ValueError(f"找不到已有归一化剖面的工况：{', '.join(missing)}")

        output_root.mkdir(parents=True, exist_ok=True)
        completed = []
        for name in names:
            try:
                z_count, output_dir = interpolate_case(name, available[name], output_root, target_c)
            except (OSError, ValueError) as exc:
                raise ValueError(f"工况 {name}：{exc}") from exc
            completed.append({"case_name": name, "profile_count": target_c.size, "z_count": z_count,
                              "output_dir": output_dir.relative_to(case_root).as_posix()})
    except (OSError, ValueError) as exc:
        parser.exit(1, f"沿 C 插值失败：{exc}\n")
    print(json.dumps({"c_count": target_c.size, "cases": completed}))


if __name__ == "__main__":
    main()
