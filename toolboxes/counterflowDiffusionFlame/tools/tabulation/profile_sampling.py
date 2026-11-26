"""正式制表和进度变量预实验共用的剖面排序与取样规则。"""

import re

import numpy as np


PROFILE_ORDER = (
    (r"transient_ignition__prof([0-9]+)", 1),
    (r"steady_flame_continuation__prof_eps([0-9]+)", -1),
    (r"frozen_flamelet__prof([0-9]+)", 1),
)


def profile_order(profile):
    for step, (pattern, direction) in enumerate(PROFILE_ORDER):
        match = re.fullmatch(pattern, profile.stem)
        if match:
            return step, direction * int(match[1]), profile.name
    raise ValueError(f"无法识别剖面文件名：{profile.name}")


def read_composition(profile, gas):
    """读取原剖面上的 Z 和按机理物种顺序排列的 Y。"""
    z = profile["Z"][()]
    y = profile["Y"][()]
    if z.ndim != 1 or y.shape != (gas.n_species, z.size):
        raise ValueError("Z 须为一维数组，且 Y 的物种数和网格点数须与机理和 Z 对应")
    molecular_weights = gas.molecular_weights
    if "W" in profile and (profile["W"].shape != molecular_weights.shape or
                           not np.allclose(profile["W"][()], molecular_weights, rtol=1e-8, atol=0)):
        raise ValueError("剖面中的物种摩尔质量 W 与机理不一致")
    return z, y


def first_crossings(source_z, target_z):
    """从燃料侧出发，为包含两个入口的目标网格找交点和插值权重。"""
    interior_z = target_z[1:-1]
    # 累计极值用于定位首次到达目标值的位置，插值使用相邻的原始点。
    downward = np.searchsorted(-np.minimum.accumulate(source_z), -interior_z)
    upward = np.searchsorted(np.maximum.accumulate(source_z), interior_z)
    crossing = np.where(interior_z < source_z[0], downward, upward)
    missing = np.flatnonzero(crossing == source_z.size)
    if missing.size:
        raise ValueError(f"原剖面未经过目标 Z={interior_z[missing[0]]:.17g}")

    # 两侧入口和恰好命中原网格的点直接取值。
    sample_indices = np.r_[source_z.size - 1, crossing, 0]
    between = np.r_[False, source_z[crossing] != interior_z, False]
    right = sample_indices[between]
    left = right - 1
    fraction = (target_z[between] - source_z[left]) / (source_z[right] - source_z[left])
    return sample_indices, between, left, fraction


def apply_crossings(values, crossings):
    indices, between, left, fraction = crossings
    values = np.asarray(values, dtype=np.result_type(values.dtype, np.float64))
    interpolated = values[..., indices]
    left_values = values[..., left]
    interpolated[..., between] = left_values + fraction * (interpolated[..., between] - left_values)
    return interpolated
