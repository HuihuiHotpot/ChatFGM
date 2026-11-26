"""逐剖面比较候选 Yc 的单调性，生成可独立查看的英文 HTML 报告。"""

import argparse
import json
import math
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile

from cantera import CanteraError, Solution
import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from profile_sampling import apply_crossings, first_crossings, profile_order, read_composition


TEST_DIRECTORY = Path("C-tabulation/00-yc_pretest")
DEFAULT_MANIFEST = Path("B-flamelet/05-postprocess/tabulation_manifest.json")
CONTINUATION = "steady_flame_continuation"
FFM = "frozen_flamelet"
TEMPLATE = Path(__file__).with_name("yc_monotonicity_template.html")


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{path}：{exc}") from exc


def input_list(inputs, field):
    values = inputs[field]
    if not isinstance(values, list) or not values:
        raise ValueError(f"{field} 须为非空列表")
    return values


def unique_names(entries, field):
    names = [entry[field] for entry in entries]
    if any(not isinstance(name, str) or not name.strip() for name in names):
        raise ValueError(f"{field} 须为非空字符串")
    if len(set(names)) != len(names):
        raise ValueError(f"{field} 不可重复")
    return names


def candidate_weights(inputs, gas):
    definitions = input_list(inputs, "candidates")
    labels = unique_names(definitions, "name")
    available = set(gas.species_names)
    for label, candidate in zip(labels, definitions):
        names = input_list(candidate, "names")
        weights = input_list(candidate, "weights")
        if len(names) != len(weights) or any(
            type(weight) not in (int, float) or not math.isfinite(weight) for weight in weights
        ):
            raise ValueError(f"候选 {label} 的物种和有限数值权重须一一对应")
        for name in names:
            if not isinstance(name, str) or name not in available:
                raise ValueError(f"候选 {label} 的物种 {name!r} 不在机理中")
        yield [gas.species_index(name) for name in names], np.asarray(weights, dtype=np.float64)


def target_grid(inputs):
    values = [point["value"] for point in input_list(inputs, "z")]
    if any(type(value) not in (int, float) or not 0 < value < 1 for value in values):
        raise ValueError("z[].value 须为大于 0 且小于 1 的数值")
    if len(set(values)) != len(values):
        raise ValueError("z[].value 不可重复")
    return np.asarray([0, *values, 1], dtype=np.float64)


def ordered_frames(case_root, case):
    ordered = []
    steps = set()
    for step, result in case["results"].items():
        directory = case_root / result["directory"]
        for entry in result["profiles"]:
            filename = entry["file"]
            if Path(filename).name != filename or Path(filename).suffix != ".h5":
                raise ValueError(f"{step}/{filename}：无效的剖面文件名")
            path = (directory / filename).resolve()
            if not path.is_relative_to(case_root / "B-flamelet"):
                raise ValueError(f"{step}/{filename}：剖面路径超出当前算例的 B-flamelet")

            try:
                order = profile_order(Path(f"{step}__{filename}"))
                frame = {"step": step, "source_profile": path.relative_to(case_root).as_posix()}
                if step == CONTINUATION:
                    rate = entry["target_strain_rate_s_inv"]
                    if type(rate) is not int or rate <= 0 or rate != -order[1]:
                        raise ValueError("清单中的目标应变率须与文件名一致")
                    frame["target_strain_rate_s_inv"] = rate
                else:
                    time = entry["time_s"]
                    if type(time) not in (int, float) or not math.isfinite(time):
                        raise ValueError("time_s 须为有限数值")
                    frame["time_s"] = float(time)
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{step}/{filename}：{exc}") from exc
            ordered.append((order, frame))
            steps.add(step)

    if len(ordered) < 2:
        raise ValueError("至少需要两条制表剖面")
    if FFM in steps and len(steps) > 1:
        raise ValueError("FFM 剖面须单独组成一个工况序列")
    ordered.sort(key=lambda item: item[0])
    for (before_key, before), (after_key, after) in zip(ordered, ordered[1:]):
        if before_key[:2] == after_key[:2]:
            raise ValueError(f"{after['source_profile']}：剖面序号或目标应变率重复")
        if (before["step"] == after["step"] != CONTINUATION
                and before["time_s"] >= after["time_s"]):
            raise ValueError(f"{after['source_profile']}：time_s 须按制表剖面顺序严格递增")
    return [frame for _, frame in ordered], -1 if FFM in steps else 1


def sample_profile(path, gas, candidates, grid):
    with h5py.File(path, "r") as profile:
        z, y = read_composition(profile, gas)
        if z.size < 2 or not np.isfinite(z).all():
            raise ValueError("原剖面的 Z 须包含至少两个有限值")
        crossings = first_crossings(z, grid)
        # 与 01 的计算顺序一致，先组合质量分数，再对原始 Yc 取样。
        yc = np.stack([weights @ y[indices] for indices, weights in candidates])
        if not np.isfinite(yc).all():
            raise ValueError("候选 Yc 含非有限值")
        return apply_crossings(yc, crossings)[:, 1:-1]


def summarize(values, direction):
    span = float(np.ptp(values))
    delta = np.diff(values)
    indices = np.flatnonzero(direction * delta < 0)
    steps = [
        {"start_index": int(index), "end_index": int(index) + 1, "delta_yc": float(delta[index])}
        for index in indices
    ]
    largest = max(steps, key=lambda step: abs(step["delta_yc"]), default=None)
    return {
        "values": values.tolist(),
        "span": span,
        "steps": steps,
        "worst": largest["start_index"] if largest else None,
        "max_relative": (abs(largest["delta_yc"]) / span if largest else 0.0) if span else None,
    }


def evaluate_case(case_root, case, gas, candidates, grid):
    name = case["case_name"]
    try:
        frames, direction = ordered_frames(case_root, case)
        samples = []
        for frame in frames:
            source = frame["source_profile"]
            try:
                samples.append(sample_profile(case_root / source, gas, candidates, grid))
            except (OSError, KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{frame['step']} 的剖面 {source}：{exc}") from exc
        values = np.stack(samples, axis=-1)  # candidate, Z, frame
        return {
            "case_name": name,
            "frames": frames,
            "direction": direction,
            "by_z": [[summarize(series, direction) for series in at_z] for at_z in values.transpose(1, 0, 2)],
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"工况 {name}：{exc}") from exc


def write_report(output, report):
    template = TEMPLATE.read_text(encoding="utf-8")
    data = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    # JSON 位于 HTML script 元素中，候选名等原样保留为数据。
    data = data.replace("<", "\\u003c")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent, prefix=".yc-", suffix=".html", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(template.replace("__YC_MONOTONICITY_DATA__", data, 1))
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-inputs", type=Path, default=TEST_DIRECTORY / "test_inputs.json")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--mechanism", type=Path, required=True, help="caseDict 中的 mechanism.reactiveFile")
    args = parser.parse_args()
    case_root = Path.cwd().resolve()
    output = case_root / TEST_DIRECTORY / "yc_monotonicity.html"
    try:
        inputs = read_json(case_root / args.test_inputs)
        names = unique_names(input_list(inputs, "samples"), "case_name")
        grid = target_grid(inputs)
        manifest = read_json(case_root / args.manifest)
        by_name = {case["case_name"]: case for case in manifest["cases"]}
        missing = [name for name in names if name not in by_name]
        if missing:
            raise ValueError(f"制表清单中找不到工况：{', '.join(missing)}")

        mechanism = (case_root / args.mechanism).read_text(encoding="utf-8-sig")
        gas = Solution(yaml=mechanism, transport_model=None)
        candidates = list(candidate_weights(inputs, gas))
        cases = [evaluate_case(case_root, by_name[name], gas, candidates, grid) for name in names]
        write_report(output, {
            "inputs": inputs,
            "manifest": args.manifest.as_posix(),
            "mechanism": args.mechanism.as_posix(),
            "cases": cases,
        })
    except (OSError, KeyError, TypeError, ValueError, OverflowError, CanteraError) as exc:
        parser.exit(1, f"Yc 单调性测试失败：{exc}\n")

    print(json.dumps({
        "output_file": str(output),
        "case_count": len(cases),
        "profile_count": sum(len(case["frames"]) for case in cases),
        "candidate_count": len(candidates),
        "z_count": len(inputs["z"]),
    }))


if __name__ == "__main__":
    main()
