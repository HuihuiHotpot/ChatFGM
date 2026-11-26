"""从着火清单选取未着火工况，计算燃烧稳态和冻结火焰面松弛。"""

import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from contextlib import redirect_stdout
from pathlib import Path


def redirect_worker_stdout():
    # 将 Ember 的 Python 和原生输出写入 stderr，保留 stdout 给 JSON 摘要。
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def run_one_case(case_name, settings):
    (
        mechanism_file, frozen_mechanism_file, run_root, fuel, oxidizer,
        dt_initial, dt_ffm, n_threads, delta_T_save, rms_T_save, n_Z,
    ) = settings
    start = time.monotonic()
    stage = "burning_steady"

    try:
        import cantera as ct

        from burning_steady import run_case as run_burning_steady
        from ffm import run_case as run_relaxation

        tf_text, to_text, pressure_text, strain_text = case_name.split("_")
        conditions = {
            "fuel": fuel,
            "oxidizer": oxidizer,
            "Tfuel": float(tf_text.removeprefix("Tf=").removesuffix(" K")),
            "Toxidizer": float(to_text.removeprefix("To=").removesuffix(" K")),
            "pressure": float(pressure_text.removeprefix("p=").removesuffix(" Pa")),
            "strain_rate": float(strain_text.removeprefix("a=").removesuffix(" s-1")),
            "n_threads": n_threads,
        }
        ct.suppress_thermo_warnings()
        print(f"[BURNING STEADY] {case_name}", file=sys.stderr, flush=True)
        restart_file = run_burning_steady(
            mechanism_file=mechanism_file,
            output_dir=run_root / "burning_steady" / case_name,
            dt=dt_initial,
            **conditions,
        )

        stage = "ffm"
        print(f"[FFM] {case_name}", file=sys.stderr, flush=True)
        run_relaxation(
            mechanism_file=frozen_mechanism_file,
            restart_file=restart_file,
            output_dir=run_root / "ffm" / case_name,
            dt=dt_ffm,
            delta_T_save=delta_T_save,
            rms_T_save=rms_T_save,
            n_Z=n_Z,
            **conditions,
        )
        return "SUCCESS", time.monotonic() - start, ""

    except Exception as exc:
        return "FAILED", time.monotonic() - start, f"{stage}: {type(exc).__name__}: {exc}"


def run_ffm(
    mechanism_file,
    frozen_mechanism_file,
    csv_file,
    run_root,
    fuel,
    oxidizer,
    composition_basis,
    dt_initial,
    dt_ffm,
    n_workers,
    n_threads,
    delta_T_save,
    rms_T_save,
    n_Z,
    case_names=None,
):
    """批量求解所选工况，返回本次运行的摘要。"""
    mechanism_file = Path(mechanism_file).resolve()
    frozen_mechanism_file = Path(frozen_mechanism_file).resolve()
    run_root = Path(run_root).resolve()
    if not mechanism_file.is_file():
        raise FileNotFoundError(f"找不到反应机理：{mechanism_file}")
    if not frozen_mechanism_file.is_file():
        raise FileNotFoundError(f"找不到零反应机理：{frozen_mechanism_file}")

    with Path(csv_file).open(newline="", encoding="utf-8-sig") as stream:
        cases = dict.fromkeys(
            row["case_name"] for row in csv.DictReader(stream) if row["ignited"] == "False"
        )
    if case_names:
        unavailable = sorted(set(case_names) - cases.keys())
        if unavailable:
            raise ValueError("以下工况未列为未着火工况：" + "，".join(unavailable))
        cases = dict.fromkeys(case_names)

    # Ember 按摩尔分数接收入口组成。
    if cases and composition_basis == "massFraction":
        with redirect_stdout(sys.stderr):
            import cantera as ct

            gas = ct.Solution(str(mechanism_file))
            gas.Y = fuel
            fuel = ", ".join(f"{name}:{value}" for name, value in gas.mole_fraction_dict().items())
            gas.Y = oxidizer
            oxidizer = ", ".join(f"{name}:{value}" for name, value in gas.mole_fraction_dict().items())

    run_root.mkdir(parents=True, exist_ok=True)
    status_file = run_root / "_status.csv"
    settings = (
        mechanism_file, frozen_mechanism_file, run_root, fuel, oxidizer,
        dt_initial, dt_ffm, n_threads, delta_T_save, rms_T_save, n_Z,
    )
    succeeded_cases = 0
    print(f"Total cases: {len(cases)}", file=sys.stderr, flush=True)
    print(f"Parallel: {n_workers} processes x {n_threads} threads", file=sys.stderr, flush=True)

    with status_file.open("a", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        if stream.tell() == 0:
            writer.writerow(["time", "case_id", "case", "status", "seconds", "message"])
            stream.flush()

        # 同一工况的两段求解依次运行，工况之间并行。
        with ProcessPoolExecutor(
            max_workers=n_workers,
            max_tasks_per_child=1,
            initializer=redirect_worker_stdout,
        ) as executor:
            futures = {
                executor.submit(run_one_case, case_name, settings): (case_id, case_name)
                for case_id, case_name in enumerate(cases, start=1)
            }
            for future in as_completed(futures):
                case_id, case_name = futures[future]
                try:
                    status, seconds, message = future.result()
                except Exception as exc:
                    status, seconds, message = "FAILED", 0.0, f"{type(exc).__name__}: {exc}"

                succeeded_cases += status == "SUCCESS"
                writer.writerow([
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    case_id, case_name, status, f"{seconds:.3f}", message,
                ])
                stream.flush()
                print(
                    f"[{status}] {case_id}/{len(cases)} {case_name} ({seconds:.1f} s) {message}".rstrip(),
                    file=sys.stderr,
                    flush=True,
                )

    return {
        "output_dir": str(run_root),
        "status_file": str(status_file),
        "total_cases": len(cases),
        "succeeded_cases": succeeded_cases,
        "failed_cases": len(cases) - succeeded_cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", dest="csv_file", default="B-flamelet/ignition_status.csv")
    parser.add_argument("--output", dest="run_root", default="B-flamelet/04-frozen_flamelet")
    parser.add_argument("--case", dest="case_names", action="append", help="工况目录名，可重复传入")
    parser.add_argument("--mechanism", dest="mechanism_file", required=True)
    parser.add_argument("--nonreactive-mechanism", dest="frozen_mechanism_file", required=True)
    parser.add_argument("--fuel", required=True)
    parser.add_argument("--oxidizer", required=True)
    parser.add_argument("--composition-basis", choices=("moleFraction", "massFraction"), required=True)
    parser.add_argument("--initial-global-timestep", dest="dt_initial", type=float, required=True)
    parser.add_argument("--global-timestep", dest="dt_ffm", type=float, required=True)
    parser.add_argument("--n-workers", type=int, required=True)
    parser.add_argument("--n-threads", type=int, required=True)
    parser.add_argument("--delta-tmax-threshold", dest="delta_T_save", type=float, required=True)
    parser.add_argument("--rms-delta-t-threshold", dest="rms_T_save", type=float, required=True)
    parser.add_argument("--n-z-points", dest="n_Z", type=int, required=True)
    args = parser.parse_args()
    try:
        result = run_ffm(**vars(args))
    except (OSError, ValueError, RuntimeError, KeyError, csv.Error) as exc:
        parser.exit(1, f"冻结火焰面调用失败：{exc}\n")
    print(json.dumps(result))
    return int(result["failed_cases"] > 0)


if __name__ == "__main__":
    sys.exit(main())
