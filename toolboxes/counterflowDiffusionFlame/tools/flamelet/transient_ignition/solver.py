"""计算一个 Ember 瞬态着火 case。"""
import math
from pathlib import Path

from ember import *

# from triggered_output import TriggeredStateWriterFactory
# from triggered_output_rms import TriggeredStateWriterFactory
from triggered_output_Tmax import TriggeredStateWriterFactory
from Tad_calculator import calculate_Tad
from Q_criterion import Q_is_steady


def run_case(
        mechanism_file,
        restart_file,
        output_dir,
        fuel,
        oxidizer,
        Tfuel,
        Toxidizer,
        pressure,
        strain_rate,
        dt=5e-8,
        n_threads=16,
        startup_delta_t_threshold=1.0,
        regular_delta_t_threshold=10.0,
        n_Z=201,
):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # state_writer = TriggeredStateWriterFactory(
    #     delta_T_save=delta_T_save,
    #     max_time_between_saves=1e-6,
    # )

    # state_writer = TriggeredStateWriterFactory(
    #     delta_T_save=20.0,
    #     rms_T_save=10.0,
    #     n_Z=201,
    # )

    state_writer = TriggeredStateWriterFactory(
        startup_delta_t_threshold=startup_delta_t_threshold,
        regular_delta_t_threshold=regular_delta_t_threshold,
        n_Z=n_Z,
    )

    conf = Config(
        Paths(
            outputDir=str(output_dir),
            logFile=str(output_dir / "solver.log"),
        ),
        Chemistry(
            mechanismFile=str(mechanism_file),
            transportModel="UnityLewis",
            kineticsModel="standard",
        ),
        InitialCondition(
            restartFile=str(restart_file),
            flameType="diffusion",
            fuel=fuel,
            oxidizer=oxidizer,
            Tfuel=Tfuel,
            Toxidizer=Toxidizer,
            pressure=pressure,
        ),
        StrainParameters(
            initial=strain_rate,
            final=strain_rate,
        ),
        General(
            nThreads=n_threads,
            chemistryIntegrator="cvode",
        ),
        Times(
            tStart=0,
            globalTimestep=dt,
            profileStepInterval=1,
            currentStateStepInterval=math.ceil(0.025 / dt) + 1,
        ),
        TerminationCondition(
            tEnd=0.025,
            measurement=None,
        ),
        OutputFiles(
            saveProfiles=True,
            stateWriter=state_writer,
            timeSeriesWriter=None,
            extraVariables=True,
        ),
        Debug(
            timesteps=False,
            regridding=False,
        ),
    )

    solver = FlameSolver(conf)
    solver.initialize()

    # 估计绝热火焰温度Tad，估算着火温度T_ignition
    Tad = calculate_Tad(
        mechanism_file,
        pressure,
        solver.T,
        solver.Y,
    )

    T_ignition = 0.5 * (Toxidizer + Tad)

    ignited = False

    # Q判据
    Q_time = []
    Q_history = []
    Q_check_counter = 0

    Q_steady = False
    Q_error = None
    Q_relative_error = None

    Q_steady_period = 0.002
    Q_tolerance = 1e-2
    Q_abstol = 0.5

    # case_status.txt日志写入设置
    report_interval = 1e-4  # 每0.1 ms打印一次
    next_report_time = report_interval

    status_file_path = output_dir / "case_status.txt"

    # 计算推进完成标志
    completed = False

    try:
        done = False

        with status_file_path.open(
                "w",
                encoding="utf-8",
        ) as status_file:

            while not done:
                done = solver.step()

                t_now = float(solver.tNow)
                Q_now = float(solver.heatReleaseRate)
                Tmax = float(max(solver.T))

                # Q历史保存
                Q_time.append(t_now)
                Q_history.append(Q_now)

                # 每10步检查一次
                Q_check_counter += 1
                check_Q_now = Q_check_counter >= 10

                if check_Q_now:
                    Q_check_counter = 0

                # 首次达到着火温度阈值
                if not ignited and Tmax >= T_ignition:
                    ignited = True
                    ignition_delay = t_now

                    print(
                        f"[IGNITION] "
                        f"t={ignition_delay * 1e3:.4f} ms, "
                        f"Tmax={Tmax:.3f} K",
                        file=status_file,
                        flush=True,
                    )

                # 未达到tEnd、已经着火且当前为检查步时，才检查Q
                if not done and ignited and check_Q_now:
                    (
                        Q_steady,
                        Q_error,
                        Q_relative_error,
                    ) = Q_is_steady(
                        Q_time,
                        Q_history,
                        t_now,
                        steady_period=Q_steady_period,
                        tolerance=Q_tolerance,
                        abstol=Q_abstol,
                    )

                    if Q_steady:
                        done = True

                # 定期打印；终止时也强制打印一次
                if t_now >= next_report_time or done:

                    if not ignited:
                        Q_status = "尚未着火，Q判据未启用"

                    elif Q_error is None:
                        Q_status = "已经着火，等待Q判据产生结果"

                    else:
                        Q_status = (
                            f"Q_error={Q_error:.4e}"
                            f"[abstol={Q_abstol:.4e}], "
                            f"Q_relative_error="
                            f"{Q_relative_error:.4e}"
                            f"[tolerance={Q_tolerance:.4e}]"
                        )

                    print(
                        f"t={t_now * 1e3:.4f} ms, "
                        f"Tmax={Tmax:.3f} K, "
                        f"Tad={Tad:.3f} K, "
                        f"Tign={T_ignition:.3f} K, "
                        f"Q={Q_now:.5e}, "
                        f"ignited={ignited}, "
                        f"Q_steady={Q_steady}, "
                        f"{Q_status}",
                        file=status_file,
                        flush=True,
                    )

                    next_report_time += report_interval

        completed = True

    finally:
        if completed:
            # 终止步会跳过周期 profile；让 finalize 保留最终状态。
            solver.stateWriter.force_next_profile()
            solver.finalize()
