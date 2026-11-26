"""从着火清单选取工况，批量运行 Ember 稳态火焰延拓。"""

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
    # 将 Ember 的 Python 和原生输出重定向到 stderr。
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def run_one_case(task):
    case_id, case_name, restart_file, settings = task
    mechanism_file, run_root, fuel, oxidizer, strain_rates, dt, n_threads = settings
    start = time.monotonic()

    try:
        tf_text, to_text, pressure_text, strain_text = case_name.split("_")
        fuel_temperature = float(tf_text.removeprefix("Tf=").removesuffix(" K"))
        oxidizer_temperature = float(to_text.removeprefix("To=").removesuffix(" K"))
        pressure = float(pressure_text.removeprefix("p=").removesuffix(" Pa"))
        initial_strain_rate = float(strain_text.removeprefix("a=").removesuffix(" s-1"))
        rates = [rate for rate in strain_rates if rate <= initial_strain_rate]

        if not rates:
            return case_id, case_name, "SKIP", time.monotonic() - start, "无小于或等于初始应变率的目标"

        import cantera as ct

        from solver import run_case

        ct.suppress_thermo_warnings()
        run_case(
            mechanism_file=mechanism_file,
            restart_file=restart_file,
            output_dir=run_root / case_name,
            fuel=fuel,
            oxidizer=oxidizer,
            Tfuel=fuel_temperature,
            Toxidizer=oxidizer_temperature,
            pressure=pressure,
            strain_rates=rates,
            dt=dt,
            n_threads=n_threads,
        )
        return case_id, case_name, "SUCCESS", time.monotonic() - start, ""

    except Exception as exc:
        return case_id, case_name, "FAILED", time.monotonic() - start, f"{type(exc).__name__}: {exc}"


def run_steady_continuation(
    mechanism_file,
    csv_file,
    run_root,
    fuel,
    oxidizer,
    composition_basis,
    strain_rates,
    dt,
    n_workers,
    n_threads,
    case_names=None,
):
    """延拓所选工况，并返回本次运行的摘要。"""
    mechanism_file = Path(mechanism_file).resolve()
    run_root = Path(run_root).resolve()
    if not mechanism_file.is_file():
        raise FileNotFoundError(f"找不到反应机理：{mechanism_file}")

    with Path(csv_file).open(newline="", encoding="utf-8-sig") as stream:
        cases = {
            row["case_name"]: Path(row["restart_file"]).resolve()
            for row in csv.DictReader(stream)
            if row["ignited"] == "True" and row["restart_file"]
        }
    if case_names:
        unavailable = sorted(set(case_names) - cases.keys())
        if unavailable:
            raise ValueError("以下工况缺少可交接的延拓初值：" + "，".join(unavailable))
        cases = {name: cases[name] for name in case_names}

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
    settings = (mechanism_file, run_root, fuel, oxidizer, strain_rates, dt, n_threads)
    tasks = [
        (case_id, case_name, restart_file, settings)
        for case_id, (case_name, restart_file) in enumerate(cases.items(), start=1)
    ]

    counts = {"SUCCESS": 0, "FAILED": 0, "SKIP": 0}
    print(f"Total cases: {len(tasks)}", file=sys.stderr, flush=True)
    print(f"Parallel: {n_workers} processes x {n_threads} threads", file=sys.stderr, flush=True)
    print(f"Target strain rates: {strain_rates} s-1", file=sys.stderr, flush=True)

    with status_file.open("a", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        if stream.tell() == 0:
            writer.writerow(["time", "case_id", "case", "status", "seconds", "message"])
            stream.flush()

        # 同一工况的应变率序列由 Ember 顺序推进，各工况在独立进程中运行。
        with ProcessPoolExecutor(
            max_workers=n_workers,
            max_tasks_per_child=1,
            initializer=redirect_worker_stdout,
        ) as executor:
            futures = {executor.submit(run_one_case, task): task for task in tasks}
            for future in as_completed(futures):
                try:
                    case_id, case_name, status, seconds, message = future.result()
                except Exception as exc:
                    case_id, case_name, _, _ = futures[future]
                    status, seconds, message = "FAILED", 0.0, f"{type(exc).__name__}: {exc}"

                counts[status] += 1
                writer.writerow([
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    case_id, case_name, status, f"{seconds:.3f}", message,
                ])
                stream.flush()
                print(
                    f"[{status}] {case_id}/{len(tasks)} {case_name} ({seconds:.1f} s) {message}".rstrip(),
                    file=sys.stderr,
                    flush=True,
                )

    return {
        "output_dir": str(run_root),
        "status_file": str(status_file),
        "total_cases": len(tasks),
        "succeeded_cases": counts["SUCCESS"],
        "failed_cases": counts["FAILED"],
        "skipped_cases": counts["SKIP"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", dest="csv_file", default="B-flamelet/ignition_status.csv")
    parser.add_argument("--output", dest="run_root", default="B-flamelet/03-steady_flame_continuation")
    parser.add_argument("--case", dest="case_names", action="append", help="工况目录名，可重复传入")
    parser.add_argument("--mechanism", dest="mechanism_file", required=True)
    parser.add_argument("--fuel", required=True)
    parser.add_argument("--oxidizer", required=True)
    parser.add_argument("--composition-basis", choices=("moleFraction", "massFraction"), required=True)
    parser.add_argument("--strain-rate", dest="strain_rates", nargs="+", type=int, required=True)
    parser.add_argument("--global-timestep", dest="dt", type=float, required=True)
    parser.add_argument("--n-workers", type=int, required=True)
    parser.add_argument("--n-threads", type=int, required=True)
    args = parser.parse_args()
    try:
        result = run_steady_continuation(**vars(args))
    except (OSError, ValueError, RuntimeError, KeyError, csv.Error) as exc:
        parser.exit(1, f"稳态延拓调用失败：{exc}\n")
    print(json.dumps(result))
    return int(result["failed_cases"] > 0)


if __name__ == "__main__":
    sys.exit(main())
