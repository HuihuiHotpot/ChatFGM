"""从燃烧稳态出发，关闭化学反应，保存向混合线松弛的过程。"""

import math
from pathlib import Path

from ember import *

from triggered_output_rms import TriggeredStateWriterFactory


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
    dt=1e-5,
    n_threads=16,
    delta_T_save=40.0,
    rms_T_save=10.0,
    n_Z=201,
):
    """mechanism_file 使用与反应机理物种顺序相同的无反应机理。"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    state_writer = TriggeredStateWriterFactory(
        delta_T_save=delta_T_save,
        rms_T_save=rms_T_save,
        n_Z=n_Z,
    )

    # 至少运行五个应变时间尺度，之后才启用 dT/dt 稳态判据。
    t_min = min(5.0 / strain_rate, 10.0)

    # 温度场在一个特征时间（1/a）内的RMS相对变化小于 steady_tol
    # steady_tol=1e-4
    dTdt_tol = 1e-4 * strain_rate

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
            currentStateStepInterval=math.ceil(10.0 / dt) + 1,
        ),
        TerminationCondition(
            tEnd=10.0,
            tMin=t_min,
            measurement="dTdt",
            dTdtTol=dTdt_tol,
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

    # 保存 t=0 的燃烧稳态剖面。
    solver.writeStateFile(None)

    done = False
    while not done:
        done = solver.step()

    # 强制保存最后一条剖面。
    solver.stateWriter.force_next_profile()
    solver.finalize()