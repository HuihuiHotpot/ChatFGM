"""在 Ember 剖面的原始网格上检查温度、组成、Bilger Z 和元素混合残差。"""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys

import cantera as ct
import h5py
import numpy as np


def select_profiles(path):
    if path.is_file() and path.suffix.lower() == ".h5":
        return [path]
    if path.is_dir():
        profiles = sorted(p for p in path.iterdir()
                          if re.fullmatch(r"prof(?:_eps)?[0-9]+\.h5", p.name) and p.is_file())
        if profiles:
            return profiles
        raise ValueError(f"目录中没有编号剖面或稳态延拓剖面：{path}")
    raise ValueError(f"需要已有的 .h5 剖面或工况目录：{path}")


@dataclass
class MixingReference:
    species: list
    elements: list
    matrix: np.ndarray
    oxidizer_elements: np.ndarray
    element_difference: np.ndarray
    beta_coefficients: np.ndarray
    beta_oxidizer: float
    beta_difference: float

    def mixture_fraction(self, y):
        return (self.beta_coefficients @ y - self.beta_oxidizer) / self.beta_difference


def load_mechanism(mechanism):
    # 由 Python 读取 UTF-8 YAML，避免 Cantera 直接打开 Windows 中文路径。
    return ct.Solution(yaml=mechanism.read_text(encoding="utf-8-sig"), transport_model=None)


def prepare_reference(mechanism, fuel, oxidizer, basis):
    return mixing_reference(load_mechanism(mechanism), fuel, oxidizer, basis)


def mixing_reference(gas, fuel, oxidizer, basis):
    weights = gas.molecular_weights
    atomic_weights = {e: gas.atomic_weight(e) for e in gas.element_names}
    matrix = np.array([
        [gas.n_atoms(i, e) * atomic_weight / weights[i] for i in range(gas.n_species)]
        for e, atomic_weight in atomic_weights.items()
    ])
    c, h, o = (matrix[gas.element_index(e)] for e in ("C", "H", "O"))
    coefficients = (2.0 * c / atomic_weights["C"]
                    + 0.5 * h / atomic_weights["H"]
                    - o / atomic_weights["O"])

    def inlet_y(composition):
        if basis == "massFraction":
            gas.Y = composition
            composition = ", ".join(f"{name}:{x}" for name, x in gas.mole_fraction_dict().items())
        gas.TPX = gas.T, gas.P, composition
        return gas.Y

    fuel_y = inlet_y(fuel)
    oxidizer_y = inlet_y(oxidizer)
    oxidizer_elements = matrix @ oxidizer_y
    beta_oxidizer = float(coefficients @ oxidizer_y)
    beta_difference = float(coefficients @ fuel_y) - beta_oxidizer
    if beta_difference == 0:
        raise ValueError("两侧入口 Bilger beta 相等，无法归一化 Z")
    return MixingReference(gas.species_names, gas.element_names, matrix, oxidizer_elements,
                           matrix @ fuel_y - oxidizer_elements, coefficients,
                           beta_oxidizer, beta_difference)


class ProfileDataError(ValueError):
    """剖面读取失败或数组不满足计算要求。"""


def read_profile(path, n_species):
    try:
        with h5py.File(path, "r") as profile:
            x, temperature, y = (np.asarray(profile[name][()]) for name in ("x", "T", "Y"))
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as exc:
        raise ProfileDataError(str(exc)) from exc
    if x.ndim != 1 or x.size < 2:
        raise ProfileDataError("x 必须是一维数组且至少有两个点")
    if temperature.shape != x.shape or y.shape != (n_species, x.size):
        raise ProfileDataError(f"T、Y 形状应为 {x.shape}、{(n_species, x.size)}，"
                               f"实际为 {temperature.shape}、{y.shape}")
    for name, data in (("x", x), ("T", temperature), ("Y", y)):
        if data.dtype.kind not in "fiu" or not np.isfinite(data).all():
            raise ProfileDataError(f"{name} 必须是有限实数")
    if np.any(x[1:] <= x[:-1]):
        raise ProfileDataError("x 必须从燃料侧到氧化剂侧严格递增")
    return x, temperature, y


def inspect_profile(path, ref):
    x, temperature, y = read_profile(path, len(ref.species))

    def point(value, index):
        return {"value": float(value), "grid_index": int(index), "x_m": float(x[index])}

    def species_point(select):
        species, index = np.unravel_index(select(y), y.shape)
        return {**point(y[species, index], index), "species": ref.species[species]}

    def at(values, index):
        return point(values[index], index)

    def largest_error(values):
        return at(values, np.argmax(np.abs(values)))

    metrics = {
        "min_temperature_k": at(temperature, np.argmin(temperature)),
        "max_temperature_k": at(temperature, np.argmax(temperature)),
        "min_y": species_point(np.argmin),
        "max_y": species_point(np.argmax),
        "max_y_sum_error": largest_error(np.sum(y, axis=0, dtype=float) - 1.0),
    }
    z = ref.mixture_fraction(y)
    low, high = np.argmin(z), np.argmax(z)
    metrics["min_z"] = {**at(z, low), "below_zero": max(0.0, -float(z[low]))}
    metrics["max_z"] = {**at(z, high), "above_one": max(0.0, float(z[high]) - 1.0)}
    metrics["left_z_error_from_one"] = point(z[0] - 1.0, 0)
    metrics["right_z_error_from_zero"] = at(z, x.size - 1)
    steps = np.diff(z)
    i = np.argmax(steps)
    rise = float(steps[i])
    metrics["max_z_rise"] = {
        "value": max(0.0, rise),
        "from": at(z, i) if rise > 0 else None,
        "to": at(z, i + 1) if rise > 0 else None,
    }

    mixed = ref.oxidizer_elements[:, None] + ref.element_difference[:, None] * z
    residuals = ref.matrix @ y - mixed
    metrics["element_residuals"] = {
        element: largest_error(row) for element, row in zip(ref.elements, residuals)
    }
    return {"file": path.name, "z": z.tolist(), "metrics": metrics}


def summarize(profiles, elements):
    checked = [p for p in profiles if "metrics" in p]
    counts = {"total_profiles": len(profiles), "checked_profiles": len(checked),
              "uncheckable_profiles": len(profiles) - len(checked)}
    worst = {}

    def select(name, choose, magnitude=False, element=None):
        def metric_for(profile):
            metric = profile["metrics"][name]
            return metric if element is None else metric[element]

        def score(profile):
            value = metric_for(profile)["value"]
            return abs(value) if magnitude else value

        selected = choose(checked, key=score)
        return {**metric_for(selected), "file": selected["file"]}

    if checked:
        for name in ("min_temperature_k", "min_y", "min_z"):
            worst[name] = select(name, min)
        for name in ("max_temperature_k", "max_y", "max_z", "max_z_rise"):
            worst[name] = select(name, max)
        for name in ("max_y_sum_error", "left_z_error_from_one", "right_z_error_from_zero"):
            worst[name] = select(name, max, magnitude=True)
        worst["element_residuals"] = {
            e: select("element_residuals", max, magnitude=True, element=e) for e in elements
        }
    return counts, worst


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--mechanism", required=True, type=Path, help="物种及顺序须与剖面一致")
    parser.add_argument("--fuel", required=True)
    parser.add_argument("--oxidizer", required=True)
    parser.add_argument("--composition-basis", required=True, choices=("moleFraction", "massFraction"))
    args = parser.parse_args()

    paths = select_profiles(args.input)
    ref = prepare_reference(args.mechanism, args.fuel, args.oxidizer, args.composition_basis)
    profiles = []
    for path in paths:
        try:
            with np.errstate(over="raise", invalid="raise", divide="raise"):
                record = inspect_profile(path, ref)
        except (ProfileDataError, FloatingPointError) as exc:
            record = {"file": path.name, "error": f"{type(exc).__name__}: {exc}"}
        profiles.append(record)

    counts, worst = summarize(profiles, ref.elements)
    report = {
        "input": {**vars(args), "input": str(args.input), "mechanism": str(args.mechanism)},
        "profiles": profiles,
        "summary": {**counts, "worst": worst},
    }
    output = paths[0].parent / "profile_quality.json"
    output.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
                      encoding="utf-8")
    print(json.dumps({"output_file": str(output), **counts}))
    return int(counts["uncheckable_profiles"] > 0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ct.CanteraError, OSError, ValueError) as exc:
        sys.exit(f"剖面检查失败：{exc}")
