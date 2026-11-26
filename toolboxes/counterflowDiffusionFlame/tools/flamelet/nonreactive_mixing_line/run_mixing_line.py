"""批量计算 Ember 非反应混合线。"""

import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from contextlib import redirect_stdout
from itertools import product
from pathlib import Path


def redirect_worker_stdout():
    # 将 Ember 的 Python 和原生输出一并写入 stderr。
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def mixing_line_case_name(Tfuel, Toxidizer, pressure_pa, strain_rate):
    Tf, To, p, a = (
        str(float(value)).removesuffix(".0")
        for value in (Tfuel, Toxidizer, pressure_pa, strain_rate)
    )
    return f"Tf={Tf} K_To={To} K_p={p} Pa_a={a} s-1"


def run_one_case(task):
    """在独立进程中计算一个 case。"""

    case_id, Tfuel, Toxidizer, pressure_pa, strain_rate, settings = task
    mechanism_file, mixing_line_root, fuel, oxidizer, global_timestep, n_threads = settings

    case_name = mixing_line_case_name(Tfuel, Toxidizer, pressure_pa, strain_rate)
    output_dir = Path(mixing_line_root) / case_name

    start = time.time()
    try:
        import cantera as ct

        from solver import run_case

        ct.suppress_thermo_warnings()
        run_case(
            mechanism_file=mechanism_file,
            output_dir=output_dir,
            fuel=fuel,
            oxidizer=oxidizer,
            Tfuel=Tfuel,
            Toxidizer=Toxidizer,
            pressure=pressure_pa,
            strain_rate=strain_rate,
            global_timestep=global_timestep,
            n_threads=n_threads,
        )

        return case_id, case_name, "SUCCESS", time.time() - start, ""

    except Exception as exc:
        return (
            case_id,
            case_name,
            "FAILED",
            time.time() - start,
            f"{type(exc).__name__}: {exc}",
        )


def run_mixing_line(
    mechanism_file,
    mixing_line_root,
    fuel,
    oxidizer,
    composition_basis,
    Tfuel_list,
    T_list,
    p_list_pa,
    strain_rates,
    global_timestep,
    n_workers,
    n_threads,
):
    """批量计算混合线并返回本次运行的摘要。"""
    mechanism_file = Path(mechanism_file)
    mixing_line_root = Path(mixing_line_root)
    if not mechanism_file.is_file():
        raise FileNotFoundError(f"Mechanism file not found: {mechanism_file}")

    # 原求解器按摩尔组成接收入口配比。
    if composition_basis == "massFraction":
        with redirect_stdout(sys.stderr):
            import cantera as ct

            gas = ct.Solution(str(mechanism_file))
            gas.Y = fuel
            fuel = ", ".join(f"{name}:{x}" for name, x in gas.mole_fraction_dict().items())
            gas.Y = oxidizer
            oxidizer = ", ".join(f"{name}:{x}" for name, x in gas.mole_fraction_dict().items())

    mixing_line_root.mkdir(parents=True, exist_ok=True)
    status_file = mixing_line_root / "_status.csv"

    if not status_file.exists():
        with status_file.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(
                ["time", "case_id", "case", "status", "seconds", "message"]
            )

    cases = list(product(Tfuel_list, T_list, p_list_pa, strain_rates))
    settings = (
        str(mechanism_file),
        str(mixing_line_root),
        fuel,
        oxidizer,
        global_timestep,
        n_threads,
    )
    tasks = [
        (case_id, float(Tfuel), float(T), float(p), float(a), settings)
        for case_id, (Tfuel, T, p, a) in enumerate(cases, start=1)
    ]

    succeeded_cases = 0
    print(f"Total cases: {len(tasks)}", file=sys.stderr, flush=True)
    print(
        f"Parallel: {n_workers} processes x {n_threads} threads",
        file=sys.stderr,
        flush=True,
    )

    # 每个 worker 只运行一个 case，完成后退出并释放 Ember/Cantera 资源。
    with ProcessPoolExecutor(
        max_workers=n_workers,
        max_tasks_per_child=1,
        initializer=redirect_worker_stdout,
    ) as executor:
        future_to_task = {
            executor.submit(run_one_case, task): task for task in tasks
        }

        for future in as_completed(future_to_task):
            task = future_to_task[future]
            try:
                result = future.result()
            except Exception as exc:
                case_id, Tfuel, T, p, a, _ = task
                case_name = mixing_line_case_name(Tfuel, T, p, a)
                result = (
                    case_id,
                    case_name,
                    "FAILED",
                    0.0,
                    f"{type(exc).__name__}: {exc}",
                )

            case_id, case_name, status, seconds, message = result
            if status == "SUCCESS":
                succeeded_cases += 1

            with status_file.open("a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(
                    [
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                        case_id,
                        case_name,
                        status,
                        f"{seconds:.3f}",
                        message,
                    ]
                )

            print(
                f"[{status}] {case_id}/{len(tasks)} {case_name} "
                f"({seconds:.1f} s) {message}".rstrip(),
                file=sys.stderr,
                flush=True,
            )

    return {
        "output_dir": str(mixing_line_root),
        "status_file": str(status_file),
        "total_cases": len(tasks),
        "succeeded_cases": succeeded_cases,
        "failed_cases": len(tasks) - succeeded_cases,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mechanism", dest="mechanism_file", required=True)
    parser.add_argument("--output", dest="mixing_line_root", required=True)
    parser.add_argument("--fuel", required=True)
    parser.add_argument("--oxidizer", required=True)
    parser.add_argument("--composition-basis", choices=("moleFraction", "massFraction"), required=True)
    parser.add_argument("--fuel-temperature", dest="Tfuel_list", nargs="+", type=float, required=True)
    parser.add_argument("--oxidizer-temperature", dest="T_list", nargs="+", type=float, required=True)
    parser.add_argument("--pressure-pa", dest="p_list_pa", nargs="+", type=float, required=True)
    parser.add_argument("--strain-rate", dest="strain_rates", nargs="+", type=float, required=True)
    parser.add_argument("--global-timestep", type=float, required=True)
    parser.add_argument("--n-workers", type=int, required=True)
    parser.add_argument("--n-threads", type=int, required=True)

    result = run_mixing_line(**vars(parser.parse_args()))
    print(json.dumps(result))
    if result["failed_cases"]:
        sys.exit(1)