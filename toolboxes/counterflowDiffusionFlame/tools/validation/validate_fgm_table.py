"""逐条验证 Stage C 的制表样本，并生成 JSON 结果和左右分栏 HTML。"""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path

import h5py
import numpy as np


TEMPLATE = Path(__file__).with_name("validation_template.html")
DEFAULT_INPUTS = Path("D-validation/validation_inputs.json")
DEFAULT_OUTPUT = Path("D-validation")
ACTIVE_THRESHOLD_FRACTION = 0.165


def text(value):
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def finite_values(dataset):
    values = np.asarray(dataset[()], dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError(f"{dataset.name} 含非有限值")
    return values


def check_grid(grid, axis):
    if (grid.ndim != 1 or grid.size < 2 or grid[0] != 0 or grid[-1] != 1
            or not np.all(np.diff(grid) > 0)):
        raise ValueError(f"{axis} 网格须从 0 到 1 严格递增")


@dataclass
class CaseTable:
    z: np.ndarray
    yc_min: np.ndarray
    yc_max: np.ndarray
    c: np.ndarray
    slices: list[Path]


def read_table(tabulation, case_name):
    bounds_path = tabulation / "03-yc_bounds" / case_name / "yc_bounds.h5"
    with h5py.File(bounds_path, "r") as bounds:
        z = finite_values(bounds["Z"])
        yc_min = finite_values(bounds["Yc_min"])
        yc_max = finite_values(bounds["Yc_max"])
    check_grid(z, "Z")
    if yc_min.shape != z.shape or yc_max.shape != z.shape:
        raise ValueError("Yc 上下界的长度与 Z 网格不一致")

    slices = []
    for path in (tabulation / "05-c_interpolated" / case_name).glob("prof_c*.h5"):
        with h5py.File(path, "r") as profile:
            c = finite_values(profile["C"])
            if c.ndim != 0:
                raise ValueError(f"{path.name} 中的 C 须为标量")
        slices.append((float(c), path))
    slices.sort(key=lambda item: item[0])
    c = np.array([value for value, _ in slices])
    check_grid(c, "C")
    return CaseTable(z, yc_min, yc_max, c, [path for _, path in slices])


def brackets(grid, coordinates):
    right = np.searchsorted(grid, coordinates)
    exact = grid[right] == coordinates
    left = np.where(exact, right, right - 1)
    weight = np.zeros_like(coordinates)
    between = ~exact
    weight[between] = ((coordinates[between] - grid[left[between]])
                       / (grid[right[between]] - grid[left[between]]))
    return left, right, weight


def coordinates(table, z, yc):
    lookup_z = np.clip(z, 0.0, 1.0)
    z_clipped = lookup_z != z
    # 将两端的入口舍入与剖面内部的越界截断分别处理。
    tolerance = 64 * np.finfo(np.float64).eps
    endpoints = [0, -1]
    rounded = np.rint(lookup_z[endpoints])
    inlet_roundoff = np.abs(z[endpoints] - rounded) <= tolerance
    lookup_z[endpoints] = np.where(inlet_roundoff, rounded, lookup_z[endpoints])
    z_clipped[endpoints] &= ~inlet_roundoff
    lower_z, upper_z, z_weight = brackets(table.z, lookup_z)
    lower = table.yc_min[lower_z] + z_weight * (table.yc_min[upper_z] - table.yc_min[lower_z])
    upper = table.yc_max[lower_z] + z_weight * (table.yc_max[upper_z] - table.yc_max[lower_z])
    interior = (lookup_z > 0) & (lookup_z < 1)
    span = upper - lower
    invalid = np.flatnonzero(interior & (span <= 0))
    if invalid.size:
        raise ValueError(f"Z={z[invalid[0]]:.17g} 处的 Yc 上下界差值须为正")

    # 入口值在所有切片相同，取 C=0 切片。入口自身的 C 记为未定义。
    raw_c = np.zeros_like(yc)
    raw_c[interior] = (yc[interior] - lower[interior]) / span[interior]
    used_c = np.clip(raw_c, 0.0, 1.0)
    c_clipped = raw_c != used_c
    return (
        (lower_z, upper_z, z_weight), brackets(table.c, used_c),
        {"z_lookup": lookup_z.tolist(), "z_clipped": z_clipped.tolist(),
         "z_clipped_count": int(np.count_nonzero(z_clipped))},
        {"raw": [float(c) if inside else None for c, inside in zip(raw_c, interior)],
         "lookup": [float(c) if inside else None for c, inside in zip(used_c, interior)],
         "clipped": c_clipped.tolist(), "clipped_count": int(np.count_nonzero(c_clipped))},
    )


def species_names(dataset):
    names = [text(name) for name in dataset.attrs["species_names"]]
    if dataset.ndim != 2 or len(names) != dataset.shape[0] or len(set(names)) != len(names):
        raise ValueError("Y 的物种名称须与数据行一一对应")
    return names


def read_reference(sample, size):
    fields = {}
    units = {}
    for name, dataset in sample.items():
        if name in {"Z", "Yc"}:
            continue
        values = finite_values(dataset)
        if values.ndim == 0:
            values = np.broadcast_to(values, size)
        if values.shape[-1] != size:
            raise ValueError(f"{name} 的最后一维须与原始采样点数一致")
        fields[name] = values
        units[name] = text(dataset.attrs["unit"])
    names = species_names(sample["Y"]) if "Y" in fields else []
    return fields, units, names


def lookup_fields(table, z_brackets, c_brackets, reference, units, names):
    z0, z1, z_weight = z_brackets
    c0, c1, c_weight = c_brackets
    results = {name: np.zeros_like(values) for name, values in reference.items()}
    # 将同一切片涉及的采样点放在一起，每个字段只读这次所需的 Z 列。
    for index in np.union1d(c0, c1):
        points = np.flatnonzero((c0 == index) | (c1 == index))
        c_factors = np.where(c0[points] == index, 1.0 - c_weight[points], c_weight[points])
        columns = np.union1d(z0[points], z1[points])
        left = np.searchsorted(columns, z0[points])
        right = np.searchsorted(columns, z1[points])
        path = table.slices[index]
        try:
            with h5py.File(path, "r") as profile:
                if not np.array_equal(profile["Z"][()], table.z):
                    raise ValueError("切片的 Z 网格与 Yc 上下界不一致")
                for name, output in results.items():
                    dataset = profile[name]
                    if text(dataset.attrs["unit"]) != units[name]:
                        raise ValueError(f"{name} 的单位与制表样本不一致")
                    values = np.asarray(dataset[..., columns], dtype=np.float64)
                    if name == "Y":
                        by_name = {key: i for i, key in enumerate(species_names(dataset))}
                        values = values[[by_name[key] for key in names]]
                    if values.shape[:-1] != output.shape[:-1] or not np.isfinite(values).all():
                        raise ValueError(f"{name} 的切片形状或数值与制表样本不匹配")
                    a, b = values[..., left], values[..., right]
                    output[..., points] += c_factors * (a + z_weight[points] * (b - a))
        except (OSError, KeyError, IndexError, TypeError, ValueError) as exc:
            raise ValueError(f"切片 {path.name}：{exc}") from exc
    return results


def active_spans(z, source):
    peak = float(np.max(source))
    if peak <= 0:
        return None, [], []
    threshold = ACTIVE_THRESHOLD_FRACTION * peak
    spans = []
    intervals = []
    for index, (a, b) in enumerate(zip(source[:-1] - threshold, source[1:] - threshold)):
        step = z[index + 1] - z[index]
        if (a <= 0 and b <= 0) or step == 0:
            continue
        start = 0.0 if a > 0 else -a / (b - a)
        end = 1.0 if b > 0 else -a / (b - a)
        length = abs(step) * (end - start)
        spans.append((index, start, end, length))
        first = float(z[index] if start == 0 else z[index] + start * step)
        last = float(z[index + 1] if end == 1 else z[index] + end * step)
        # 原始剖面可沿 Z 递减。合并连续活跃线段用于结果展示。
        if (intervals and intervals[-1][1] == first
                and (intervals[-1][1] > intervals[-1][0]) == (step > 0)):
            intervals[-1][1] = last
        else:
            intervals.append([first, last])
    return threshold, spans, [sorted(interval) for interval in intervals]


def error_metrics(z, reference, residual, spans, active_length):
    max_index = int(np.argmax(np.abs(residual)))
    peak = float(np.max(np.abs(reference)))
    percent = None
    if peak > 0 and active_length > 0:
        integral = 0.0
        for index, start, end, length in spans:
            first = residual[index]
            change = residual[index + 1] - first
            a, b = first + change * start, first + change * end
            total = abs(a) + abs(b)
            # 残差跨零时，沿线性残差积分绝对值，分别计入零点两侧。
            mean = (a * a + b * b) / (2 * total) if a * b < 0 else total / 2
            integral += mean * length
        percent = float(100 * integral / active_length / peak)
    return {
        "max_absolute_error": float(abs(residual[max_index])),
        "max_error_index": max_index,
        "max_error_z": float(z[max_index]),
        "active_zone_nmae_percent": percent,
    }


def variable_results(z, reference, lookup, units, names, spans, active_length):
    output = []
    for field, values in reference.items():
        category = {"Y": "species", "omega_Yc": "sources"}.get(field, "other")
        for component in np.ndindex(values.shape[:-1]):
            label = field
            if field == "Y":
                label = names[component[0]]
            elif component:
                label += "[" + ",".join(map(str, component)) + "]"
            ref, tab = values[component], lookup[field][component]
            residual = tab - ref
            output.append({
                "field": field, "name": label, "component": list(component),
                "category": category, "unit": units[field],
                "reference": ref.tolist(), "lookup": tab.tolist(), "residual": residual.tolist(),
                **error_metrics(z, ref, residual, spans, active_length),
            })
    return output


def evaluate_sample(case_root, path, table):
    with h5py.File(path, "r") as sample:
        z = finite_values(sample["Z"])
        yc = finite_values(sample["Yc"])
        if z.ndim != 1 or z.size < 2 or yc.shape != z.shape:
            raise ValueError("Z 和 Yc 须为同长度的一维剖面数组")
        reference, units, names = read_reference(sample, z.size)
        source = reference["omega_Yc"]
        if source.shape != z.shape:
            raise ValueError("omega_Yc 须与 Z 网格等长")
        source_profile = text(sample.attrs["source_profile"])

    z_brackets, c_brackets, z_usage, progress = coordinates(table, z, yc)
    lookup = lookup_fields(table, z_brackets, c_brackets, reference, units, names)
    threshold, spans, intervals = active_spans(z, source)
    active_length = float(sum(span[3] for span in spans))
    return {
        "sample": path.relative_to(case_root).as_posix(),
        "source_profile": source_profile,
        "z": z.tolist(), **z_usage, "yc": yc.tolist(), "c": progress,
        "active_zone": {"threshold": threshold, "intervals": intervals, "length": active_length},
        "variables": variable_results(z, reference, lookup, units, names, spans, active_length),
    }


def evaluate(case_root, inputs):
    tabulation = case_root / "C-tabulation"
    cases = []
    seen = set()
    for entry in inputs["cases"]:
        name = entry["case_name"]
        if not name or name in {".", ".."} or Path(name).name != name or name in seen:
            raise ValueError(f"无效或重复的制表工况名：{name!r}")
        seen.add(name)
        directory = (tabulation / "01-prepared_samples" / name).resolve()
        samples = entry["samples"]
        if not isinstance(samples, list) or not samples:
            raise ValueError(f"工况 {name} 须选取至少一份 HDF5 样本")
        try:
            table = read_table(tabulation, name)
            profiles = []
            selected = set()
            for item in samples:
                path = (case_root / item).resolve()
                if path.parent != directory or path.suffix.lower() != ".h5" or path in selected:
                    raise ValueError(f"样本路径重复或不属于该工况的 01-prepared_samples：{item}")
                selected.add(path)
                try:
                    profiles.append(evaluate_sample(case_root, path, table))
                except (OSError, KeyError, IndexError, TypeError, ValueError) as exc:
                    raise ValueError(f"样本 {item}：{exc}") from exc
            cases.append({"case_name": name, "profiles": profiles})
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"工况 {name}：{exc}") from exc
    if not cases:
        raise ValueError("输入清单未选择任何工况")
    return {"active_threshold_fraction": ACTIVE_THRESHOLD_FRACTION, "cases": cases}


def result_paths(directory):
    return directory / "validation_results.json", directory / "validation.html"


def write_report(directory, report):
    template = TEMPLATE.read_text(encoding="utf-8")
    data = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    # 将同一份结果嵌入 HTML，允许直接从工作台打开。
    html = template.replace("__FGM_VALIDATION_DATA__", data.replace("<", "\\u003c"), 1)
    directory.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        for output, content in zip(result_paths(directory), (data + "\n", html)):
            with output.open("x", encoding="utf-8") as target:
                created.append(output)
                target.write(content)
    except (OSError, UnicodeError):
        for output in created:
            output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=DEFAULT_INPUTS,
                        help="JSON 清单，各 cases 条目含 case_name 和样本路径列表 samples")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="验证结果目录")
    args = parser.parse_args()
    case_root = Path.cwd().resolve()
    directory = (case_root / args.output_dir).resolve()
    try:
        inputs = json.loads((case_root / args.inputs).read_text(encoding="utf-8-sig"))
        report = evaluate(case_root, inputs)
        write_report(directory, report)
    except (OSError, KeyError, TypeError, ValueError, OverflowError) as exc:
        parser.exit(1, f"先验验证失败：{exc}\n")

    print(json.dumps({
        "result_file": result_paths(directory)[0].as_posix(),
        "report_file": result_paths(directory)[1].as_posix(),
        "case_count": len(report["cases"]),
        "profile_count": sum(len(case["profiles"]) for case in report["cases"]),
    }))


if __name__ == "__main__":
    main()
