"""按 Stage B 制表清单，逐工况准备原网格样本。"""

import argparse
import json
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory

from cantera import CanteraError, Solution
import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from profile_sampling import read_composition


REACTIVE_STEPS = {"transient_ignition", "steady_flame_continuation"}
TABULATION_STEPS = REACTIVE_STEPS | {"frozen_flamelet"}


def select_cases(manifest, names):
    cases = manifest["cases"]
    if names:
        by_name = {case["case_name"]: case for case in cases}
        unique_names = list(dict.fromkeys(names))
        missing = [name for name in unique_names if name not in by_name]
        if missing:
            raise ValueError(f"清单中找不到工况：{', '.join(missing)}")
        cases = [by_name[name] for name in unique_names]
    if not cases:
        raise ValueError("制表清单中没有待处理工况")
    return cases


def profile_paths(case_root, case):
    flamelet_root = case_root / "B-flamelet"
    for step, result in case["results"].items():
        if step not in TABULATION_STEPS:
            raise ValueError(f"工况 {case['case_name']} 的清单含有不参与制表的来源步骤：{step}")
        directory = case_root / result["directory"]
        for entry in result["profiles"]:
            filename = entry["file"]
            if Path(filename).name != filename or Path(filename).suffix != ".h5":
                raise ValueError(f"无效的剖面文件名：{filename}")
            path = (directory / filename).resolve()
            if not path.is_relative_to(flamelet_root):
                raise ValueError(f"原始剖面不在当前算例的 B-flamelet 内：{path}")
            yield step, path


def load_derive_function(path):
    try:
        function = runpy.run_path(str(path)).get("derive_variables")
    except Exception as exc:
        raise ValueError(f"无法加载派生脚本 {path}：{exc}") from exc
    if not callable(function):
        raise ValueError(f"派生脚本 {path} 缺少 derive_variables 函数")
    return function


def collect_fields(profile, step, gas, progress, species_indices, extra_fields):
    indices, weights = progress
    z, y = read_composition(profile, gas)
    molecular_weights = gas.molecular_weights

    yc = weights @ y[indices]
    if step in REACTIVE_STEPS:
        wdot = profile["wdot"][()]
        if wdot.shape != y.shape:
            raise ValueError("wdot 与 Y 的形状不一致")
        omega_yc = (weights * molecular_weights[indices]) @ wdot[indices]
    else:
        omega_yc = np.zeros_like(yc)

    fields = {"Z": (z, "1"), "Yc": (yc, "kg/kg"), "omega_Yc": (omega_yc, "kg/(m^3*s)")}
    for name, (values, _) in fields.items():
        if not np.isfinite(values).all():
            raise ValueError(f"{name} 含非有限值")

    if species_indices:
        fields["Y"] = (y[species_indices], "kg/kg")
    for name, dataset, unit in extra_fields:
        if name in fields:
            raise ValueError(f"输出字段重复：{name}")
        fields[name] = (profile[dataset][()], unit)
    return fields


def add_derived_fields(profile, case, gas, derive, fields, methods):
    try:
        derived = derive(profile, case, gas)
    except Exception as exc:
        raise ValueError(f"派生变量计算失败：{exc}") from exc
    if not isinstance(derived, dict):
        raise ValueError("derive_variables 须返回以变量名为键的字典")
    for name, record in derived.items():
        if name in fields:
            raise ValueError(f"输出字段重复：{name}")
        try:
            values = np.asarray(record["value"])
            if values.dtype.kind in "fc" and not np.isfinite(values).all():
                raise ValueError(f"派生字段 {name} 含 NaN 或 Inf")
            fields[name] = (values, record["unit"])
            methods[name, record["source"]] = None
        except (KeyError, TypeError) as exc:
            raise ValueError(f"派生字段 {name} 须包含 value、unit 和 source：{exc}") from exc


def write_sample(path, source, fields, output_species):
    with h5py.File(path, "x") as sample:
        sample.attrs["source_profile"] = source.as_posix()
        for name, (values, unit) in fields.items():
            try:
                sample.create_dataset(name, data=values).attrs["unit"] = unit
            except (TypeError, ValueError) as exc:
                raise ValueError(f"无法保存字段 {name}：{exc}") from exc
        if output_species:
            sample["Y"].attrs["species_names"] = output_species


def prepare_cases(case_root, cases, args, gas, derive):
    weights = np.asarray(args.progress_weights, dtype=np.float64)
    if len(args.progress_species) != len(weights) or not np.isfinite(weights).all():
        raise ValueError("进度变量物种与有限的权重须按顺序一一对应")
    progress = ([gas.species_index(name) for name in args.progress_species], weights)
    output_species = gas.species_names if args.output_species == ["all"] else args.output_species
    species_indices = [gas.species_index(name) for name in output_species]

    output_root = case_root / "C-tabulation/01-prepared_samples"
    output_root.mkdir(parents=True, exist_ok=True)
    completed = []
    for case in cases:
        name = case["case_name"]
        if not name or name in (".", "..") or Path(name).name != name:
            raise ValueError(f"无效的工况目录名：{name!r}")
        output_dir = output_root / name
        if output_dir.exists():
            raise FileExistsError(f"样本目录已存在：{output_dir}")

        methods = {}
        profile_count = 0
        # 样本和说明全部写完后，再发布整个工况目录。
        with TemporaryDirectory(prefix=".preparing-", dir=output_root) as temporary:
            staged = Path(temporary) / "samples"
            staged.mkdir()
            for step, source in profile_paths(case_root, case):
                relative_source = source.relative_to(case_root)
                try:
                    with h5py.File(source, "r") as profile:
                        fields = collect_fields(profile, step, gas, progress, species_indices, args.field)
                        if derive is not None:
                            add_derived_fields(profile, case, gas, derive, fields, methods)
                    write_sample(staged / f"{step}__{source.name}", relative_source, fields, output_species)
                except (OSError, KeyError, TypeError, ValueError, FloatingPointError) as exc:
                    raise ValueError(f"工况 {name} 的剖面 {relative_source}：{exc}") from exc
                profile_count += 1

            if not profile_count:
                raise ValueError(f"工况 {name} 在清单中没有剖面")
            notes = ["# 来源工况", "", f"`{name}`"]
            notes.extend(["", "## 制表采用的进度变量", ""])
            notes.extend(
                f"- `{species}` 权重为 `{weight}`"
                for species, weight in zip(args.progress_species, args.progress_weights)
            )
            notes.append(f"- 配套反应机理 `{args.mechanism.as_posix()}`")
            if args.derive_script is not None:
                notes.extend(["", "## 派生量计算方法", "", f"脚本 `{args.derive_script.as_posix()}`", ""])
                notes.extend(f"- `{field}` {source}" for field, source in methods)
            (staged / "case.md").write_text("\n".join(notes).rstrip() + "\n", encoding="utf-8")
            staged.rename(output_dir)

        completed.append({
            "case_name": name,
            "profile_count": profile_count,
            "output_dir": output_dir.relative_to(case_root).as_posix(),
        })
    return completed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("B-flamelet/05-postprocess/tabulation_manifest.json"),
                        help="制表清单，相对路径以算例根目录为基准")
    parser.add_argument("--case", action="append", help="选定工况的完整 case_name，可重复传入")
    parser.add_argument("--mechanism", type=Path, required=True, help="与原剖面配套的 Cantera YAML 机理")
    parser.add_argument("--progress-species", nargs="+", required=True, help="进度变量物种")
    parser.add_argument("--progress-weights", nargs="+", required=True, type=float, help="与物种顺序对应的权重")
    parser.add_argument("--output-species", nargs="+", default=[], help="要保存的物种质量分数，支持 all")
    parser.add_argument("--field", nargs=3, action="append", default=[], metavar=("NAME", "DATASET", "UNIT"),
                        help="直接读取的字段，依次传入输出名、原数据集名和单位，可重复传入")
    parser.add_argument("--derive-script", type=Path, help="提供 derive_variables 的 Python 脚本")
    args = parser.parse_args()

    case_root = Path.cwd().resolve()
    try:
        manifest = json.loads((case_root / args.manifest).read_text(encoding="utf-8-sig"))
        cases = select_cases(manifest, args.case)
        mechanism = (case_root / args.mechanism).read_text(encoding="utf-8-sig")
        gas = Solution(yaml=mechanism, transport_model=None)
        derive = load_derive_function(case_root / args.derive_script) if args.derive_script is not None else None
        completed = prepare_cases(case_root, cases, args, gas, derive)
    except (OSError, KeyError, TypeError, ValueError, CanteraError) as exc:
        parser.exit(1, f"制表样本准备失败：{exc}\n")

    print(json.dumps({"cases": completed}))


if __name__ == "__main__":
    main()
