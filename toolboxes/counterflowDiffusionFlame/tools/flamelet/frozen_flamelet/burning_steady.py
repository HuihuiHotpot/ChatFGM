"""用 Ember 默认高温初场，计算指定工况的燃烧稳态。"""

import math
from pathlib import Path

from ember import *


def run_case(
    mechanism_file,
    output_dir,
    fuel,
    oxidizer,
    Tfuel,
    Toxidizer,
    pressure,
    strain_rate,
    dt=5e-8,
    n_threads=16,
):

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

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
        # 不指定 restartFile，使用 Ember 自带的高温平衡产物初场。
        InitialCondition(
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
            currentStateStepInterval=math.ceil(10.0 / dt) + 1,
        ),
        TerminationCondition(
            tEnd=10.0,
            measurement="Q",
        ),
        OutputFiles(
            saveProfiles=False,
            timeSeriesWriter=None,
            extraVariables=True,
        ),
        Debug(
            timesteps=False,
            regridding=False,
        ),
    )

    solver = conf.run()
    solver.writeStateFile("steady")

    return output_dir / "steady.h5"