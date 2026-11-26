"""运行一个 Ember 非反应混合线 case。"""

import math
from pathlib import Path

import cantera as ct
from ember import *

from initial import build_initial_field


def run_case(
    mechanism_file,
    output_dir,
    fuel,
    oxidizer,
    Tfuel,
    Toxidizer,
    pressure,
    strain_rate,
    global_timestep=1e-6,
    t_end=10.0,
    steady_tol = 1e-4,
    n_threads=16,
):
    """计算一个混合线 case，并返回 Ember solver。"""

    mechanism_file = str(mechanism_file)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    gas = ct.Solution(mechanism_file)
    field = build_initial_field(
        gas,
        fuel,
        oxidizer,
        Tfuel,
        Toxidizer,
        pressure,
        strain_rate,
    )

    # 混合线只需要初始和最终剖面，不保存积分过程中的大量中间剖面。
    max_steps = math.ceil(t_end / global_timestep) + 1

    # 至少运行五个应变时间尺度，之后才启用 dT/dt 稳态判据。
    t_min = min(5.0 / strain_rate, t_end)

    # 温度场在一个特征时间（1/a）内的RMS相对变化小于 steady_tol
    dTdt_tol = steady_tol * strain_rate

    conf = Config(
        Paths(
            outputDir=str(output_dir),
            logFile=str(output_dir / "solver.log"),
        ),
        Chemistry(
            mechanismFile=mechanism_file,
            transportModel="UnityLewis",
        ),
        InitialCondition(
            flameType="diffusion",
            haveProfiles=True,
            pressure=pressure,
            fuel=fuel,
            oxidizer=oxidizer,
            Tfuel=Tfuel,
            Toxidizer=Toxidizer,
            **field,
        ),
        StrainParameters(
            initial=strain_rate,
            final=strain_rate,
        ),
        General(
            nThreads=n_threads,
        ),
        Times(
            globalTimestep=global_timestep,
            outputStepInterval=max_steps,
            outputTimeInterval=t_end + global_timestep,
            profileStepInterval=max_steps,
            profileTimeInterval=t_end + global_timestep,
            currentStateStepInterval= max_steps,
        ),
        TerminationCondition(
            tEnd=t_end,
            tMin=t_min,
            measurement="dTdt",
            dTdtTol=dTdt_tol,
        ),
        Debug(
            timesteps=False,
            regridding=False,
        )
    )

    return conf.run()