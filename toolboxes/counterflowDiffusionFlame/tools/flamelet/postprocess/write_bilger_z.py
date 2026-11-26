"""按火焰面结果清单，在原始 Ember 剖面中补写 Bilger Z。"""

import argparse
import json
from pathlib import Path
import sys

from cantera import CanteraError
import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from profile_diagnostics.check_profile_quality import load_mechanism, mixing_reference


def profile_paths(case_root, manifest):
    flamelet = case_root / "B-flamelet"
    for case in manifest["cases"]:
        for result in case["results"].values():
            directory = case_root / result["directory"]
            for profile in result["profiles"]:
                path = (directory / profile["file"]).resolve()
                if not path.is_relative_to(flamelet):
                    raise ValueError(f"清单中的剖面路径超出当前算例的 B-flamelet：{path}")
                yield path


def write_z(path, reference, n_species):
    with h5py.File(path, "r+") as profile:
        if "Z" in profile:
            return False

        x = profile["x"]
        y = profile["Y"][()]
        if x.ndim != 1 or y.shape != (n_species, x.size):
            raise ValueError("Y 的物种维度或网格点数不匹配")

        z = reference.mixture_fraction(y)
        if not np.isfinite(z).all():
            raise ValueError("计算得到的 Z 含非有限数值")

        profile.create_dataset("Z", data=z)
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-root", type=Path, default=Path.cwd(), help="算例根目录，默认当前目录")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("B-flamelet/05-postprocess/flamelet_manifest.json"),
        help="结果清单路径，相对路径以算例根目录为基准（默认：%(default)s）",
    )
    parser.add_argument("--mechanism", required=True, type=Path, help="反应机理文件，物种顺序须与剖面一致")
    parser.add_argument("--fuel", required=True, help="燃料侧入口组成")
    parser.add_argument("--oxidizer", required=True, help="氧化剂侧入口组成")
    parser.add_argument("--composition-basis", required=True, choices=("moleFraction", "massFraction"))
    args = parser.parse_args()

    case_root = args.case_root.resolve()
    manifest_path = case_root / args.manifest
    written = reused = 0
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        gas = load_mechanism(case_root / args.mechanism)
        reference = mixing_reference(gas, args.fuel, args.oxidizer, args.composition_basis)
        for path in profile_paths(case_root, manifest):
            try:
                added = write_z(path, reference, gas.n_species)
            except (OSError, KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{path}：{exc}") from exc
            if added:
                written += 1
            else:
                reused += 1
    except (OSError, KeyError, TypeError, ValueError, CanteraError) as exc:
        parser.exit(1, f"写入 Bilger Z 失败：{exc}\n")

    print(json.dumps({
        "manifest": str(manifest_path),
        "profiles_written": written,
        "profiles_reused": reused,
    }))


if __name__ == "__main__":
    main()
